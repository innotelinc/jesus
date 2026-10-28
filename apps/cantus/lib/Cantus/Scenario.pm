package Cantus::Scenario;
# Runs a complete two-party call across real sockets, optionally behind real
# NAT middleboxes.  Shared by the CLI demo and the test suite so that what the
# demo shows is exactly what the tests assert.
use strict;
use warnings;
use Time::HiRes qw(time sleep);

use Cantus::Relay ();
use Cantus::Node ();
use Cantus::NatSim ();
use Cantus::Router ();

sub new {
    my ($class, %a) = @_;
    return bless {
        nat    => $a{nat} // 'none',      # none | cone | symmetric
        secret => $a{secret} // 'cantus-demo-secret',
        trace  => $a{trace} // sub { },
        direct => $a{direct} // 0,
        caps   => $a{caps},
        debug  => $a{debug} // 0,
    }, $class;
}

sub _emit {
    my ($self, $who, $ev) = @_;
    $ev = { %$ev };
    $ev->{t} //= time - ($self->{started} // time);
    $self->{trace}->($who, $ev);
    push @{ $self->{events} }, { %$ev, who => $who };

    if (($ev->{kind} // '') eq 'rebind') {
        push @{ $self->{detections} }, {
            who => $who, trigger => $ev->{trigger}, idle_ms => $ev->{after_ms}, t => $ev->{t},
        };
        my $ms = $ev->{after_ms} // 0;
        $self->{detect_ms} = $ms if !defined $self->{detect_ms} || $ms < $self->{detect_ms};
    }

    if (($ev->{kind} // '') eq 'path') {
        push @{ $self->{path_history} },
            { who => $who, path => $ev->{path}, switch => $ev->{switch} ? 1 : 0, t => $ev->{t} };
        $self->{fell_back} = 1 if $ev->{path} eq 'relay' && $ev->{switch};
        if ($self->{fell_back} && $ev->{path} eq 'direct') {
            $self->{recovered_at} //= $ev->{t};
            $self->{frames_at_recovery} //= ($self->{bob} ? $self->{bob}{received_frames} : 0);
        }
    }
    $self->{premature_end}++
        if ($ev->{kind} // '') eq 'ended' && !$self->{hanging_up};
}

# Flush the middleboxes' UDP tables: every mapping is gone and new public ports
# are allocated, so the media paths have to be re-established.  Passing sides
# rebinds only those endpoints -- the caller alone, or the callee alone.
sub rebind {
    my ($self, @sides) = @_;
    @sides = qw(alice bob) unless @sides;
    my @done;
    for my $side (@sides) {
        my $nat = $self->{nats}{$side} or next;
        $nat->rebind;
        $self->{rebinds}++;
        push @done, $side;
        $self->_emit($side, { kind => 'rebind-nat', mode => $nat->mode });
    }
    $self->{rebound_sides} = [ @done ];
    return scalar @done;
}

sub _pump_all {
    my ($self, $seconds) = @_;
    my $until = time + $seconds;
    while (1) {
        # One non-blocking drain per component, then a single sleep.  Asking each
        # of five sockets to wait out its own sub-millisecond slice costs a full
        # system timer tick per socket on some platforms (Windows select rounds
        # up to ~15 ms), which throttles the whole harness to ~20 Hz and lets a
        # busy relay fall a second behind the media stream.
        $self->{relay}->pump(0) if $self->{relay};
        for my $n (values %{ $self->{nats} || {} }) { $n->pump(0) }
        $self->{alice}->pump(0);
        $self->{bob}->pump(0);
        my $left = $until - time;
        last if $left <= 0;
        sleep($left > 0.002 ? 0.002 : $left);
    }
}

sub run {
    my ($self, %a) = @_;
    $self->{started} = time;
    $self->{events} = [];
    $self->{path_history} = [];
    my $nat_mode = $self->{nat};
    my $direct   = $self->{direct};

    my $relay;
    unless ($direct) {
        $relay = Cantus::Relay->new(
            bind     => '127.0.0.1:0',
            secret   => $self->{secret},
            debug    => $self->{debug} // 0,
            on_event => sub { $self->_emit('relay', $_[0]) },
        );
        $self->{relay} = $relay;
    }

    my $caps = $self->{caps};
    my $mk = sub {
        my ($id, $tone) = @_;
        return Cantus::Node->new(
            id       => $id,
            secret   => $self->{secret},
            tone_hz  => $tone,
            relay    => $relay ? $relay->addr : undef,
            caps     => $caps,
            debug    => $self->{debug} // 0,
            auto_answer => 1,
            on_event => sub { $self->_emit($id, $_[0]) },
        );
    };
    $self->{alice} = $mk->('alice@demo', 440);
    $self->{bob}   = $mk->('bob@demo',   880);

    if ($nat_mode ne 'none') {
        for my $side (qw(alice bob)) {
            my $nat = Cantus::NatSim->new(
                mode     => $nat_mode,
                debug    => $self->{debug} // 0,
                on_event => sub { $self->_emit($side, $_[0]) },
            );
            $self->{nats}{$side} = $nat;
            $self->{$side}{via} = $nat->attach($self->{$side});
            $self->_emit($side, { kind => 'nat', mode => $nat_mode, at => $nat->addr });
        }
    }
    else {
        # No middlebox: a static directory is enough to reach the peer.
        $self->{alice}{peers}{'bob@demo'}   = { addr => $self->{bob}->addr };
        $self->{bob}{peers}{'alice@demo'}   = { addr => $self->{alice}->addr };
    }

    if ($relay) {
        $self->{alice}->register;
        $self->{bob}->register;
        my $deadline = time + 5;
        while (time < $deadline) {
            $self->_pump_all(0.02);
            last if $self->{alice}->handle && $self->{bob}->handle;
        }
        return { ok => 0, error => 'registration failed' }
            unless $self->{alice}->handle && $self->{bob}->handle;
    }

    $self->_pump_all(0.05);
    my $call = $self->{alice}->call('bob@demo');
    return { ok => 0, error => 'call setup failed' } unless $call;

    my $deadline = time + 6;
    my ($alice_s, $bob_s);
    while (time < $deadline) {
        $self->_pump_all(0.02);
        $alice_s = $self->{alice}{sessions}{$call};
        $bob_s   = $self->{bob}{sessions}{$call};
        last if $alice_s && $bob_s && $alice_s->is_active && $bob_s->is_active;
    }
    unless ($alice_s && $bob_s && $alice_s->is_active && $bob_s->is_active) {
        return { ok => 0, error => 'call never became active', call => $call };
    }

    my $media_seconds = $a{media_seconds} // 1.2;
    my $rebind_at     = $a{rebind_at};
    my $rebind_sides  = $a{rebind_sides} || [ qw(alice bob) ];
    my $t0 = time;
    my $did_rebind = 0;
    # Sample the receive counter to measure the longest silence the listener
    # actually heard: a failover that keeps the call but loses two seconds of
    # audio must not be reported as seamless.
    my $seen = $self->{bob}{received_frames} // 0;
    my $last_audio = 0;
    my ($max_gap, $gap_at) = (0, undef);
    while (time - $t0 < $media_seconds) {
        $self->_pump_all(0.01);
        my $now_n = $self->{bob}{received_frames} // 0;
        if ($now_n != $seen) {
            my $now = time - $t0;
            my $gap = $now - $last_audio;
            if ($gap > $max_gap) { $max_gap = $gap; $gap_at = $now }
            $last_audio = $now;
            $seen = $now_n;
        }
        if (!$did_rebind && defined $rebind_at && time - $t0 >= $rebind_at) {
            $did_rebind = 1;
            $self->rebind(@$rebind_sides);
        }
        last unless $alice_s->is_active && $bob_s->is_active;
    }

    my $frames = $self->{bob}->{received_frames};
    my $peak   = $self->{bob}->{receive_peak};
    my $path   = $alice_s->{committed};
    my $result = {
        ok          => $frames > 10 && $peak > 1000,
        call        => $call,
        path        => $path,
        bob_path    => $bob_s->{committed},
        frames      => $frames,
        peak        => $peak,
        direct_frames => $self->{bob}{direct_frames},
        relay_frames  => $self->{bob}{relay_frames},
        codec       => $alice_s->{codec} ? $alice_s->{codec}{name} : undef,
        nat         => $nat_mode,
        relay_stats => $relay ? $relay->stats : undef,
        nat_stats   => { map { $_ => $self->{nats}{$_}->stats } keys %{ $self->{nats} || {} } },
        events      => $self->{events},
        active_ms   => int(($alice_s->{started} ? (time - $alice_s->{started}) : 0) * 1000),
        path_history => $self->{path_history},
        fell_back   => $self->{fell_back} ? 1 : 0,
        recovered_at => $self->{recovered_at},
        frames_at_recovery => $self->{frames_at_recovery},
        premature_end => $self->{premature_end} || 0,
        active_at_end => ($alice_s->is_active && $bob_s->is_active) ? 1 : 0,
        rebinds     => $self->{rebinds} || 0,
        rebind_sides => $self->{rebound_sides} || [],
        max_gap     => $max_gap,
        gap_at      => $gap_at,
        detect_ms   => $self->{detect_ms},
        detections  => $self->{detections} || [],
    };

    $self->{hanging_up} = 1;
    $self->{alice}->hangup($call, 'NORMAL');
    my $bye_until = time + 1.0;
    $self->_pump_all(0.02) while time < $bye_until && !$bob_s->is_ended;
    $result->{ended} = $bob_s->is_ended;
    return $result;
}

1;
