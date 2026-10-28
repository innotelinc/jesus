package Cantus::Relay;
# A Cantus relay: a registry, an observed-address reporter, and a datagram
# forwarder.  It holds no call state and cannot read media.
# See spec/CANTUS-1.0.md sections 8.2, 8.3, 9.6.
use strict;
use warnings;
use IO::Socket::INET;
use IO::Select;
use Socket qw(sockaddr_in inet_aton inet_ntoa);
use Time::HiRes qw(time);

use Cantus::Wire ();
use Cantus::Identity ();
use Cantus::Pump ();

sub new {
    my ($class, %a) = @_;
    my $self = bless {
        secret    => $a{secret} // 'cantus-loopback',
        on_event  => $a{on_event} // sub { },
        by_handle => {},     # handle -> { addr, id, expires }
        by_id     => {},     # endpoint id -> handle
        next_handle => 1000,
        forwarded => 0,
        dropped   => 0,
        debug     => $a{debug} // 0,
        running   => 1,
        log       => [],
    }, $class;
    my $bind = $a{bind} // '127.0.0.1:0';
    my ($h, $p) = split /:/, $bind, 2;
    $self->{sock} = IO::Socket::INET->new(
        LocalAddr => $h, LocalPort => ($p || 0), Proto => 'udp', ReuseAddr => 1,
    ) or die "Cantus::Relay bind $bind: $!";
    $self->{sock}->blocking(0);
    $self->{addr} = (($h eq '0.0.0.0' || !$h) ? '127.0.0.1' : $h) . ':' . $self->{sock}->sockport;
    $self->{ident} = Cantus::Identity->new(name => 'relay@' . $self->{addr}, secret => $self->{secret});
    $self->{started} = time;
    return $self;
}

sub addr     { $_[0]{addr} }
sub port     { $_[0]{sock}->sockport }
sub stop     { $_[0]{running} = 0 }
sub registry { $_[0]{by_handle} }
sub stats {
    my ($s) = @_;
    return {
        forwarded => $s->{forwarded},
        dropped   => $s->{dropped},
        endpoints => scalar(keys %{ $s->{by_handle} }),
    };
}

sub emit {
    my ($self, $ev) = @_;
    my $rec = { %$ev, t => time - $self->{started} };
    push @{ $self->{log} }, $rec;
    $self->{on_event}->($rec);
}

# See Cantus::Pump and spec §15: pump(0) drains the queue and returns without
# waiting; pump($t) serves for at most $t; pump() is one default slice.
sub pump {
    my ($self, $seconds) = @_;
    my $until = Cantus::Pump::deadline($seconds);
    my $sel = IO::Select->new($self->{sock});
    while ($self->{running}) {
        last if Cantus::Pump::expired($seconds, $until);
        my @r = $sel->can_read(Cantus::Pump::wait_for($seconds, $until - time));
        last if Cantus::Pump::finished($seconds, \@r);
        for my $s (@r) {
            my $buf;
            my $peer = recv($s, $buf, 65535, 0);
            next unless defined $peer && length $buf;
            my ($port, $iaddr) = sockaddr_in($peer);
            my $src = inet_ntoa($iaddr) . ':' . $port;
            $self->emit({ kind => 'rx', src => $src, len => length $buf,
                          dgram => (Cantus::Wire::kind($buf) // -1) }) if $self->{debug};
            eval { $self->handle_datagram($buf, $src) };
            $self->emit({ kind => 'error', error => $@ }) if $@;
        }
    }
}

sub sendto {
    my ($self, $dest, $bytes) = @_;
    my ($ip, $port) = split /:/, $dest, 2;
    return unless defined $port;
    $self->{sock}->send($bytes, 0, scalar sockaddr_in($port, inet_aton($ip)));
}

sub handle_datagram {
    my ($self, $buf, $src) = @_;
    my $kind = Cantus::Wire::kind($buf);
    return unless defined $kind;

    if ($kind == 2) {
        my $r = Cantus::Wire::relay_decode($buf);
        my $dest;
        if ($r->{route} == 0) {
            my $handle = $self->{by_id}{ $r->{name} // '' };
            $dest = $handle ? $self->{by_handle}{$handle}{addr} : undef;
        }
        else {
            my $e = $self->{by_handle}{ $r->{route} };
            $dest = $e ? $e->{addr} : undef;
        }
        unless ($dest) { $self->{dropped}++; return }
        $self->sendto($dest, $r->{inner});
        $self->{forwarded}++;
        # Address refresh is registration-driven (section 8.2); a forwarder must
        # not repoint a handle based on who happened to send it a frame.
        $self->emit({ kind => 'forward', route => $r->{route}, name => $r->{name},
                      dest => $dest, len => length $r->{inner} })
            if Cantus::Wire::kind($r->{inner}) == 0;
        return;
    }

    if ($kind == 0) {
        my ($type, $f) = Cantus::Wire::msg_decode($buf);
        return unless $type == 13;      # REGISTER
        my $id = $f->{11} ? $f->{11}[1] : $f->{1}[1];
        return unless defined $id;
        my $handle = $self->{by_id}{$id};
        unless ($handle) {
            $handle = $self->{next_handle}++;
            $self->{by_id}{$id} = $handle;
        }
        $self->{by_handle}{$handle} = {
            addr    => $src,
            id      => $id,
            expires => time + 60,
            limits  => $f->{10} ? $f->{10}[1] : '',
        };
        my ($ip, $port) = split /:/, $src, 2;
        my $observed = Cantus::Wire::varint_encode(4)
                     . Cantus::Wire::varint_encode(length $ip) . $ip
                     . Cantus::Wire::varint_encode($port);
        my $grant = Cantus::Wire::varint_encode($handle)
                  . Cantus::Wire::varint_encode(300_000)
                  . Cantus::Wire::varint_encode(4096)
                  . Cantus::Wire::varint_encode(length $self->{addr}) . $self->{addr};
        my $reply = {
            19 => Cantus::Wire::B($observed),
            15 => Cantus::Wire::V($handle),
            20 => Cantus::Wire::B($grant),
            11 => Cantus::Wire::S('relay@' . $self->{addr}),
            4  => Cantus::Wire::V(int(time * 1000) & 0x7fffffff),
        };
        $reply->{5} = Cantus::Wire::B($self->{ident}->sign(14, $reply));
        $self->sendto($src, Cantus::Wire::msg_encode(14, $reply));
        $self->emit({ kind => 'registered', id => $id, handle => $handle, addr => $src });
        return;
    }
}

1;
