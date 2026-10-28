package Cantus::Caps;
# Capability sets and one-round-trip negotiation.
# See spec/CANTUS-1.0.md section 6.
use strict;
use warnings;
use Cantus::Wire ();

sub _var { Cantus::Wire::varint_encode($_[0]) }

sub encode {
    my (@caps) = @_;
    my $out = _var(scalar @caps);
    for my $c (@caps) {
        my $params = $c->{params} // {};
        $out .= _var(length $c->{name}) . $c->{name};
        $out .= _var($c->{ptime} // 20);
        $out .= _var($c->{bitrate} // 0);
        my @keys = sort keys %$params;
        $out .= _var(scalar @keys);
        for my $k (@keys) {
            $out .= _var(length $k) . $k;
            $out .= _var(length $params->{$k}) . $params->{$k};
        }
    }
    return $out;
}

sub decode {
    my ($bytes) = @_;
    my $pos = 0;
    my $n   = Cantus::Wire::varint_decode($bytes, \$pos);
    die "cantus: too many capabilities\n" if $n > 32;
    my @caps;
    for (1 .. $n) {
        my $name = _take($bytes, \$pos);
        my $cap = {
            name    => $name,
            ptime   => Cantus::Wire::varint_decode($bytes, \$pos),
            bitrate => Cantus::Wire::varint_decode($bytes, \$pos),
            params  => {},
        };
        my $np = Cantus::Wire::varint_decode($bytes, \$pos);
        die "cantus: too many codec parameters\n" if $np > 32;
        for (1 .. $np) {
            my $k = _take($bytes, \$pos);
            my $v = _take($bytes, \$pos);
            $cap->{params}{$k} = $v;
        }
        push @caps, $cap;
    }
    return \@caps;
}

sub _take {
    my ($bytes, $posref) = @_;
    my $l = Cantus::Wire::varint_decode($bytes, $posref);
    die "cantus: truncated string\n" if $$posref + $l > length $bytes;
    my $s = substr($bytes, $$posref, $l);
    $$posref += $l;
    return $s;
}

sub codec_id {
    my ($name) = @_;
    my ($base) = split m{/}, lc $name;
    return 1 if $base eq 'opus';
    return 2 if $base eq 'pcm-s16';
    return 3 if $base eq 'red';
    return 0;
}

sub codec_rate {
    my ($name) = @_;
    my (undef, $rate) = split m{/}, lc $name;
    return $rate || 48000;
}

sub codec_name {
    my ($id) = @_;
    return 'opus'    if $id == 1;
    return 'pcm-s16' if $id == 2;
    return 'red'     if $id == 3;
    return "codec-$id";
}

sub _parts {
    my ($name) = @_;
    my ($base, $clock, $chan) = split m{/}, lc $name;
    return ($base, $clock || 48000, $chan || 1);
}

# Negotiation, section 6.2: walk the offer in order, take the first answer
# entry with the same base name and compatible clock and channels.  Exactly one
# codec results, and the caller's order decides.
sub negotiate {
    my ($offer, $answer) = @_;
    for my $o (@$offer) {
        my ($obase, $oclock, $ochan) = _parts($o->{name});
        for my $a (@$answer) {
            my ($abase, $aclock, $achan) = _parts($a->{name});
            next unless $obase eq $abase;
            next unless $oclock == $aclock && $ochan == $achan;
            my %params = (%{ $o->{params} }, %{ $a->{params} });
            return {
                name    => $o->{name},
                codec   => codec_id($o->{name}),
                rate    => codec_rate($o->{name}),
                ptime   => $a->{ptime}   || $o->{ptime}   || 20,
                bitrate => $a->{bitrate} || $o->{bitrate} || 0,
                params  => \%params,
            };
        }
    }
    return undef;
}

sub production_set {
    return (
        { name => 'opus/48000/2', ptime => 20, bitrate => 32,
          params => { useinbandfec => '1', dtx => '1', maxaveragebitrate => '32000' } },
        { name => 'opus/48000/1', ptime => 20, bitrate => 24,
          params => { useinbandfec => '1', dtx => '1' } },
    );
}

sub loopback_set {
    # 8 kHz mono PCM is 320 octets per 20 ms frame, which keeps every datagram
    # under the 1150-octet limit of section 13.
    return (
        { name => 'pcm-s16/8000/1', ptime => 20, bitrate => 128, params => {} },
        { name => 'opus/48000/1',   ptime => 20, bitrate => 24,
          params => { useinbandfec => '1' } },
    );
}

sub describe {
    my ($caps) = @_;
    return join(', ', map {
        my $p = $_->{params} || {};
        my $extra = join(';', map { "$_=$p->{$_}" } sort keys %$p);
        $_->{name} . "/$_->{ptime}" . ($extra ? "[$extra]" : '')
    } @$caps);
}

1;
