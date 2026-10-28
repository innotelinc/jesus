package Cantus::Media;
# Media framing helpers, the conformance codec, and receiver-side quality maths.
# See spec/CANTUS-1.0.md section 9.
use strict;
use warnings;
use Cantus::Wire qw();

use constant {
    OPUS_RATE => 48_000,
    PCM_RATE  => 8_000,
};

sub frame_samples {
    my ($ptime, $rate) = @_;
    return int(($rate // PCM_RATE) * ($ptime // 20) / 1000);
}

# pcm-s16 test codec: a sine frame, little-endian signed 16-bit.
sub pcm_frame {
    my (%a) = @_;
    my $hz  = $a{hz}  // 440;
    my $amp = $a{amp} // 6000;
    my $n   = $a{samples} // frame_samples($a{ptime} // 20, $a{rate} // PCM_RATE);
    my $phase = $a{phase} // 0;
    my $rate  = $a{rate} // PCM_RATE;
    my @s;
    my $step = 2 * 3.14159265358979 * $hz / $rate;
    for my $i (0 .. $n - 1) {
        push @s, int($amp * sin($phase + $i * $step));
    }
    return (pack('s<*', @s), ($phase + $n * $step) % (2 * 3.14159265358979));
}

# Peak amplitude of a pcm-s16 payload, used by tests to prove audio arrived.
sub peak {
    my ($payload) = @_;
    return 0 unless length($payload) >= 2;
    my @v = unpack('s<*', $payload);
    my $max = 0;
    for (@v) { my $a = $_ < 0 ? -$_ : $_; $max = $a if $a > $max }
    return $max;
}

# Receiver quality report, section 9.5.  `recv_high` is the highest media
# sequence number this receiver has seen from the peer.  It is what lets a
# sender discover that its own packets are not landing: locally it can only
# count what it sent, never what arrived.
my @REPORT_FIELDS = qw(loss_q8 rtt_us jitter_us recv_kbps desired_kbps frames_lost recv_high);

sub report_fields { @REPORT_FIELDS }

sub report_encode {
    my (%r) = @_;
    my $out = '';
    for my $k (@REPORT_FIELDS) {
        $out .= Cantus::Wire::varint_encode($r{$k} // 0);
    }
    return $out;
}

sub report_decode {
    my ($bytes) = @_;
    return {} unless defined $bytes;
    my $pos = 0;
    my %r;
    for my $k (@REPORT_FIELDS) {
        # A peer that predates recv_high sends fewer fields.  A missing tail is
        # not an error; it only means that peer cannot report reception, and
        # failover then falls back to silence detection.
        last if $pos >= length $bytes;
        $r{$k} = Cantus::Wire::varint_decode($bytes, \$pos);
    }
    return \%r;
}

1;
