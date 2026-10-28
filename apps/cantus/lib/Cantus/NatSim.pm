package Cantus::NatSim;
# A real UDP middlebox used by the test suite and the demo.  Packets genuinely
# traverse it; it is not a simulation inside the endpoints.
#
#   symmetric : a distinct public port per destination (the hard NAT)
#   cone      : one public port, inbound allowed from any contacted address
#
# One NatSim instance fronts exactly one endpoint.  The endpoint sends through
# the NAT (`via` hook), and the NAT delivers inbound datagrams via `inject`.
use strict;
use warnings;
use IO::Socket::INET;
use IO::Select;
use Socket qw(sockaddr_in inet_aton inet_ntoa);
use Time::HiRes qw(time);

use Cantus::Pump ();

sub new {
    my ($class, %a) = @_;
    my $self = bless {
        mode     => $a{mode} // 'symmetric',
        ip       => $a{ip} // '127.0.0.1',
        owner    => undef,
        pub      => {},       # symmetric: destination -> public socket
        cone     => undef,
        mapping  => {},       # destination -> 1
        dropped  => 0,
        rebinds  => 0,
        forwarded => 0,
        on_event => $a{on_event} // sub { },
    }, $class;
    $self->{debug} = $a{debug} // 0;

    $self->{sock} = IO::Socket::INET->new(
        LocalAddr => $self->{ip}, LocalPort => 0, Proto => 'udp', ReuseAddr => 1,
    ) or die "Cantus::NatSim: $!";
    $self->{sock}->blocking(0);
    $self->{addr} = $self->{ip} . ':' . $self->{sock}->sockport;

    $self->{cone} = $self->_pub_socket if $self->{mode} eq 'cone';
    return $self;
}

sub addr  { $_[0]{addr} }
sub mode  { $_[0]{mode} }
sub stats {
    my ($s) = @_;
    return { mode => $s->{mode}, dropped => $s->{dropped}, forwarded => $s->{forwarded} };
}

sub _pub_socket {
    my ($self) = @_;
    my $s = IO::Socket::INET->new(
        LocalAddr => $self->{ip}, LocalPort => 0, Proto => 'udp', ReuseAddr => 1,
    ) or die "Cantus::NatSim public socket: $!";
    $s->blocking(0);
    return $s;
}

# Attach the endpoint behind this NAT; returns its `via` closure.
sub attach {
    my ($self, $node) = @_;
    $self->{owner} = $node;
    my $nat = $self;
    return sub {
        my ($dest, $bytes) = @_;
        $nat->outbound($dest, $bytes);
    };
}

sub outbound {
    my ($self, $dest, $bytes) = @_;
    $self->{mapping}{$dest} = 1;
    if ($self->{mode} eq 'cone') {
        $self->_send($self->{cone}, $dest, $bytes);
        return;
    }
    my $sock = $self->{pub}{$dest} ||= $self->_pub_socket;
    $self->_send($sock, $dest, $bytes);
}

sub _send {
    my ($self, $sock, $dest, $bytes) = @_;
    my ($ip, $port) = split /:/, $dest, 2;
    my $sent = $sock->send($bytes, 0, scalar sockaddr_in($port, inet_aton($ip)));
    $self->{forwarded}++ if defined $sent;
}

sub _public_addr {
    my ($sock) = @_;
    my ($port, $iaddr) = sockaddr_in($sock->sockname);
    return inet_ntoa($iaddr) . ':' . $port;
}

# Drop every mapping and allocate fresh public ports.  This is what a consumer
# router does when its UDP table is flushed or its lease expires: traffic to the
# old ports is gone, and everything must be re-established.
sub rebind {
    my ($self) = @_;
    close $_ for grep { defined } values %{ $self->{pub} };
    close $self->{cone} if $self->{cone};
    $self->{pub}     = {};
    $self->{mapping} = {};
    $self->{cone}    = $self->_pub_socket if $self->{mode} eq 'cone';
    $self->{rebinds}++;
    $self->{on_event}->({ kind => 'rebound', mode => $self->{mode} }) if $self->{debug};
    return $self->{rebinds};
}

# Drain the internal socket (outbound) and public sockets (inbound).
# See Cantus::Pump and spec §15: pump(0) drains the queue and returns without
# waiting; pump($t) serves for at most $t; pump() is one default slice.
sub pump {
    my ($self, $seconds) = @_;
    my $until = Cantus::Pump::deadline($seconds);
    while (1) {
        last if Cantus::Pump::expired($seconds, $until);
        my $sel = IO::Select->new($self->{sock});
        $sel->add($self->{cone}) if $self->{cone};
        $sel->add(values %{ $self->{pub} }) if %{ $self->{pub} };
        my @ready = $sel->can_read(Cantus::Pump::wait_for($seconds, $until - time));
        last if Cantus::Pump::finished($seconds, \@ready);
        for my $s (@ready) {
            my $buf;
            my $peer = recv($s, $buf, 65535, 0);
            next unless defined $peer && length $buf;
            my ($port, $iaddr) = sockaddr_in($peer);
            my $src = inet_ntoa($iaddr) . ':' . $port;
            if ($s == $self->{sock}) {
                # 1-octet length, destination, payload
                my $len  = ord(substr($buf, 0, 1));
                my $dest = substr($buf, 1, $len);
                $self->outbound($dest, substr($buf, 1 + $len));
            }
            else {
                $self->_inbound($s, $src, $buf);
            }
        }
    }
}

sub _inbound {
    my ($self, $sock, $src, $bytes) = @_;
    $self->{on_event}->({ kind => 'inbound', src => $src, len => length $bytes,
                          port => _public_addr($sock) }) if $self->{debug};
    # Unsolicited inbound is dropped: an existing mapping toward that exact
    # source is required.  This is the property that breaks naive traversal.
    unless ($self->{mapping}{$src}) {
        $self->{dropped}++;
        $self->{on_event}->({ kind => 'drop', src => $src, len => length $bytes,
                              have => join(',', sort keys %{ $self->{mapping} }) })
            if $self->{debug};
        return;
    }
    return unless $self->{owner};
    $self->{on_event}->({ kind => 'deliver', src => $src, len => length $bytes,
                          to => _public_addr($sock) }) if $self->{debug};
    # The endpoint sees the true source address, exactly as a transparent
    # middlebox would present it.
    $self->{owner}->inject($bytes, $src);
}

1;
