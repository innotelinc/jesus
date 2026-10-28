package Cantus::Reach;
# Reach: candidate lists, path tokens, and path decisions.
# See spec/CANTUS-1.0.md section 8.
use strict;
use warnings;
use Digest::SHA qw(sha256);
use Cantus::Wire ();

use constant { KIND_UDP4 => 0, KIND_UDP6 => 1, KIND_TCP => 2, PATH_DIRECT => 0, PATH_RELAY => 1 };

sub cands_encode {
    my (@cands) = @_;
    my $out = Cantus::Wire::varint_encode(scalar @cands);
    for my $c (@cands) {
        $out .= Cantus::Wire::varint_encode($c->{kind} // KIND_UDP4);
        $out .= Cantus::Wire::varint_encode(length $c->{ip}) . $c->{ip};
        $out .= Cantus::Wire::varint_encode($c->{port});
        $out .= Cantus::Wire::varint_encode($c->{priority} // 100);
        my $tok = $c->{token} // "\0" x 8;
        $out .= Cantus::Wire::varint_encode(length $tok) . $tok;
    }
    return $out;
}

sub cands_decode {
    my ($bytes) = @_;
    return [] unless defined $bytes && length $bytes;
    my $pos = 0;
    my $n = Cantus::Wire::varint_decode($bytes, \$pos);
    die "cantus: too many candidates\n" if $n > 16;
    my @cands;
    for (1 .. $n) {
        my $kind = Cantus::Wire::varint_decode($bytes, \$pos);
        my $l = Cantus::Wire::varint_decode($bytes, \$pos);
        die "cantus: truncated candidate\n" if $pos + $l > length $bytes;
        my $ip = substr($bytes, $pos, $l);
        $pos += $l;
        my $port = Cantus::Wire::varint_decode($bytes, \$pos);
        my $prio = Cantus::Wire::varint_decode($bytes, \$pos);
        my $tl = Cantus::Wire::varint_decode($bytes, \$pos);
        my $tok = substr($bytes, $pos, $tl);
        $pos += $tl;
        push @cands, { kind => $kind, ip => $ip, port => $port,
                       priority => $prio, token => $tok };
    }
    return \@cands;
}

# 8-octet candidate token, 16-octet probe challenge.  Both sides derive the
# same values from the call, which is what makes a probe verifiable.
sub cand_token {
    my ($call, $gen) = @_;
    return substr(sha256("cantus/1-cand:$call:$gen"), 0, 8);
}

sub challenge {
    my ($call, $gen) = @_;
    return substr(sha256("cantus/1-path:$call:$gen"), 0, 16);
}

sub addr { my ($c) = @_; return "$c->{ip}:$c->{port}" }

1;
