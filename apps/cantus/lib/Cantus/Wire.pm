package Cantus::Wire;
# Cantus 1.0 wire format: varints, TLV fields, datagram kinds.
# See spec/CANTUS-1.0.md sections 4.3, 5.1, 5.2, 9.1.
use strict;
use warnings;
use Digest::SHA qw(sha256);

our $MAGIC = 0xCA;
our $VERSION_TOKEN = 'cantus/1';

# ---------------------------------------------------------------- primitives

sub varint_encode {
    my ($n) = @_;
    $n = int($n);
    die "cantus: negative varint\n" if $n < 0;
    my $out = '';
    while (1) {
        my $b = $n & 0x7F;
        $n >>= 7;
        if ($n) { $out .= pack('C', $b | 0x80); }
        else    { $out .= pack('C', $b); last; }
    }
    return $out;
}

sub varint_decode {
    my ($data, $posref) = @_;
    my $v     = 0;
    my $shift = 0;
    my $n     = 0;
    my $len   = length($data);
    while (1) {
        die "cantus: truncated varint\n" if $$posref >= $len;
        my $b = ord(substr($data, $$posref, 1));
        $$posref++;
        $v |= ($b & 0x7F) << $shift;
        $n++;
        last unless $b & 0x80;
        die "cantus: varint longer than 9 octets\n" if $n >= 9;
        $shift += 7;
    }
    return $v;
}

# Typed field values.  A field is [wire_type, value].
sub V { return [ 0, int($_[0]) ] }          # varint
sub S { return [ 2, "$_[0]" ] }             # utf-8 string / opaque bytes
sub B { return [ 2, "$_[0]" ] }             # opaque bytes
sub U64 { return [ 1, $_[0] ] }
sub U32 { return [ 5, $_[0] ] }

sub value_bytes {
    my ($spec) = @_;
    my ($wt, $v) = @$spec;
    return varint_encode($v)      if $wt == 0;
    return "$v"                   if $wt == 2;
    return pack('Q<', $v)         if $wt == 1;
    return pack('V', $v)          if $wt == 5;
    die "cantus: bad wire type $wt\n";
}

sub type_name {
    my ($t) = @_;
    my %names = (
        1 => 'HELLO', 2 => 'HELLO_ACK', 3 => 'INVITE', 4 => 'RING',
        5 => 'ACCEPT', 6 => 'REJECT', 7 => 'TERMINATE', 8 => 'PATH',
        9 => 'PATH_ACK', 10 => 'FEEDBACK', 11 => 'PROBE', 12 => 'INFO',
        13 => 'REGISTER', 14 => 'REGISTER_ACK',
    );
    return $names{$t} // "TYPE_$t";
}

sub type_id {
    my ($name) = @_;
    my %ids = reverse (
        1 => 'HELLO', 2 => 'HELLO_ACK', 3 => 'INVITE', 4 => 'RING',
        5 => 'ACCEPT', 6 => 'REJECT', 7 => 'TERMINATE', 8 => 'PATH',
        9 => 'PATH_ACK', 10 => 'FEEDBACK', 11 => 'PROBE', 12 => 'INFO',
        13 => 'REGISTER', 14 => 'REGISTER_ACK',
    );
    return $ids{uc $name} // die "cantus: unknown message '$name'\n";
}

# ---------------------------------------------------------------- control

# Encode a CONTROL datagram.  Fields are emitted in ascending id order so the
# bytes are canonical, which the signature digest depends on.
sub msg_encode {
    my ($type, $fields) = @_;
    my $out = pack('C', $MAGIC) . pack('C', 0) . varint_encode($type);
    for my $id (sort { $a <=> $b } keys %$fields) {
        next unless defined $fields->{$id};
        my $spec = $fields->{$id};
        $out .= varint_encode(($id << 3) | $spec->[0]);
        $out .= $spec->[0] == 2
            ? varint_encode(length $spec->[1]) . $spec->[1]
            : value_bytes($spec);
    }
    die "cantus: datagram exceeds 1150 octets\n" if length($out) > 1150;
    return $out;
}

sub decode_fields {
    my ($data, $posref) = @_;
    my $len    = length($data);
    my %fields;
    my $count  = 0;
    while ($$posref < $len) {
        my $tag = varint_decode($data, $posref);
        my $id  = $tag >> 3;
        my $wt  = $tag & 0x7;
        die "cantus: field id out of range\n" if $id < 1 || $id > 4095;
        die "cantus: too many fields\n" if ++$count > 64;
        if ($wt == 0) {
            $fields{$id} = [ 0, varint_decode($data, $posref) ];
        }
        elsif ($wt == 2) {
            my $l = varint_decode($data, $posref);
            die "cantus: truncated field\n" if $$posref + $l > $len;
            $fields{$id} = [ 2, substr($data, $$posref, $l) ];
            $$posref += $l;
        }
        elsif ($wt == 1) {
            die "cantus: truncated fixed64\n" if $$posref + 8 > $len;
            $fields{$id} = [ 1, unpack('Q<', substr($data, $$posref, 8)) ];
            $$posref += 8;
        }
        elsif ($wt == 5) {
            die "cantus: truncated fixed32\n" if $$posref + 4 > $len;
            $fields{$id} = [ 5, unpack('V', substr($data, $$posref, 4)) ];
            $$posref += 4;
        }
        else {
            die "cantus: unknown wire type $wt\n";
        }
    }
    return \%fields;
}

sub msg_decode {
    my ($data) = @_;
    die "cantus: short datagram\n" if length($data) < 3;
    die "cantus: bad magic\n" unless ord(substr($data, 0, 1)) == $MAGIC;
    die "cantus: not a control datagram\n" unless ord(substr($data, 1, 1)) == 0;
    my $pos  = 2;
    my $type = varint_decode($data, \$pos);
    my $fields = decode_fields($data, \$pos);
    return ($type, $fields);
}

# Plain-text rendering, for logs, traces and the CLI.
sub describe {
    my ($type, $fields) = @_;
    my %short = (
        1 => 'from', 2 => 'to', 3 => 'call', 4 => 'nonce', 5 => 'sig',
        6 => 'gen', 7 => 'reason', 8 => 'text', 9 => 'caps', 10 => 'limits',
        11 => 'node', 12 => 'cands', 13 => 'token', 14 => 'path', 15 => 'handle',
        16 => 'time', 17 => 'payload', 18 => 'event', 19 => 'observed',
        20 => 'grant', 21 => 'version', 22 => 'stream', 23 => 'report', 24 => 'key',
    );
    my @parts;
    for my $id (sort { $a <=> $b } keys %$fields) {
        my ($wt, $v) = @{ $fields->{$id} };
        my $name = $short{$id} // "f$id";
        my $shown = $wt == 2
            ? ($v =~ /^[\x20-\x7e]{0,40}$/ ? "\"$v\"" : sprintf('%d bytes', length $v))
            : $v;
        push @parts, "$name=$shown";
    }
    return type_name($type) . ' ' . join(' ', @parts);
}

# ---------------------------------------------------------------- media

sub media_encode {
    my (%a) = @_;
    my $out = pack('C', $MAGIC) . pack('C', 1)
        . varint_encode($a{stream} // 0)
        . varint_encode($a{tag}    // 0)
        . varint_encode($a{seq}    // 0)
        . varint_encode($a{ts}     // 0)
        . varint_encode($a{codec}  // 1)
        . varint_encode($a{flags}  // 0)
        . ($a{payload} // '');
    return $out;
}

sub media_decode {
    my ($data) = @_;
    die "cantus: bad media datagram\n" if length($data) < 10;
    die "cantus: bad magic\n" unless ord(substr($data, 0, 1)) == $MAGIC;
    die "cantus: not a media datagram\n" unless ord(substr($data, 1, 1)) == 1;
    my $pos = 2;
    my %m;
    $m{stream} = varint_decode($data, \$pos);
    $m{tag}    = varint_decode($data, \$pos);
    $m{seq}    = varint_decode($data, \$pos);
    $m{ts}     = varint_decode($data, \$pos);
    $m{codec}  = varint_decode($data, \$pos);
    $m{flags}  = varint_decode($data, \$pos);
    $m{payload} = substr($data, $pos);
    return \%m;
}

# ---------------------------------------------------------------- relay

# RELAY = magic 0x02 route:varint [name:string when route==0] inner
# route == 0 addresses a peer by EndpointId, resolved by the relay's registry.
sub relay_encode {
    my ($route, $inner, $name) = @_;
    my $out = pack('C', $MAGIC) . pack('C', 2) . varint_encode($route);
    if (!defined $route || $route == 0) {
        $out .= varint_encode(length($name // '')) . ($name // '');
    }
    return $out . $inner;
}

sub relay_decode {
    my ($data) = @_;
    die "cantus: bad relay datagram\n" if length($data) < 3;
    die "cantus: bad magic\n" unless ord(substr($data, 0, 1)) == $MAGIC;
    die "cantus: not a relay datagram\n" unless ord(substr($data, 1, 1)) == 2;
    my $pos   = 2;
    my $route = varint_decode($data, \$pos);
    my $name;
    if ($route == 0) {
        my $l = varint_decode($data, \$pos);
        die "cantus: truncated relay name\n" if $pos + $l > length($data);
        $name = substr($data, $pos, $l);
        $pos += $l;
    }
    return { route => $route, name => $name, inner => substr($data, $pos) };
}

sub kind {
    my ($data) = @_;
    return undef if length($data) < 2;
    return undef unless ord(substr($data, 0, 1)) == $MAGIC;
    return ord(substr($data, 1, 1));
}

# ---------------------------------------------------------------- signatures

# Canonical signing input, section 10.2.  Field 5 (sig) is excluded.
sub signing_input {
    my ($type, $fields) = @_;
    my $out = $VERSION_TOKEN . '-sig' . varint_encode($type);
    for my $id (sort { $a <=> $b } keys %$fields) {
        next if $id == 5;
        next unless defined $fields->{$id};
        my $bytes = value_bytes($fields->{$id});
        $out .= varint_encode($id) . varint_encode(length($bytes)) . $bytes;
    }
    return $out;
}

sub digest {
    my ($type, $fields) = @_;
    return sha256(signing_input($type, $fields));
}

1;
