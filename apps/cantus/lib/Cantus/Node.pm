package Cantus::Node;
# A Cantus endpoint: one socket, one event loop, signalling + media + Reach.
# See spec/CANTUS-1.0.md sections 5, 7, 8, 9.
use strict;
use warnings;
use IO::Socket::INET;
use IO::Select;
use Socket qw(sockaddr_in inet_aton inet_ntoa);
use Time::HiRes qw(time);
use Digest::SHA qw(sha256);

use Cantus::Wire ();
use Cantus::Caps ();
use Cantus::Identity ();
use Cantus::Session ();
use Cantus::Media ();
use Cantus::Reach ();
use Cantus::Router ();
use Cantus::Pump ();

use constant {
    T_RING      => 32,
    T_TERMINATE => 4,
    T_KEEPALIVE => 15,
    T_REACH     => 0.300,
    T_REBIND    => 2.0,        # safety net: silence this long is always a break
    T_REBIND_FAST => 0.400,    # silence this long while the peer is still reporting
    FB_LIVE     => 1.0,        # a report newer than this means the peer is alive
    SEND_STALL  => 16,         # frames sent since the peer last confirmed receiving any
    REFRESH     => 20,
    MEDIA_TICK  => 0.020,
    FEEDBACK    => 0.200,
};

my %SIGNED = map { $_ => 1 } qw(HELLO HELLO_ACK INVITE ACCEPT TERMINATE REGISTER REGISTER_ACK);

sub tag_for {
    my ($call) = @_;
    return unpack('n', substr(sha256($call), 0, 2));
}

sub new {
    my ($class, %a) = @_;
    my $id = $a{id} // die "Cantus::Node requires an id\n";
    my $self = bless {
        id          => $id,
        secret      => $a{secret} // 'cantus-loopback',
        caps        => $a{caps} // [ Cantus::Caps::loopback_set() ],
        peers       => $a{peers} // {},
        relay       => $a{relay},
        router      => $a{router},
        on_event    => $a{on_event} // sub { },
        auto_answer => $a{auto_answer} // 1,
        ring_delay  => $a{ring_delay} // 0,
        debug       => $a{debug} // 0,
        sessions    => {},
        timers      => [],
        timer_seq   => 0,
        nonce       => 0,
        require_sig => $a{require_sig} // 1,
        log         => [],
        via         => $a{via},
        handle      => 0,
        observed    => undef,
        ready       => 0,
        running     => 1,
        tone_hz     => $a{tone_hz} // 440,
        received_frames => 0,
        receive_peak => 0,
        relay_frames => 0,
        direct_frames => 0,
    }, $class;

    $self->{limits} = {
        max_calls     => 8,
        max_streams   => 1,
        max_bitrate   => 128,
        keepalive_ms  => 15000,
        reach_ms      => 300,
        max_datagram  => 1150,
        %{ $a{limits} // {} },
    };

    $self->{ident} = Cantus::Identity->new(name => $self->{id}, secret => $self->{secret});
    my $bind = $a{bind} // '127.0.0.1:0';
    my ($h, $p) = split /:/, $bind, 2;
    $self->{sock} = IO::Socket::INET->new(
        LocalAddr => $h, LocalPort => ($p || 0), Proto => 'udp', ReuseAddr => 1,
    ) or die "Cantus::Node bind $bind: $!";
    $self->{sock}->blocking(0);
    $self->{addr} = (($h eq '0.0.0.0' || !$h) ? '127.0.0.1' : $h) . ':' . $self->{sock}->sockport;
    $self->{started} = time;
    $self->{next_media} = time;
    $self->{next_keepalive} = time + T_KEEPALIVE;
    return $self;
}

sub id       { $_[0]{id} }
sub addr     { $_[0]{addr} }
sub port     { $_[0]{sock}->sockport }
sub handle   { $_[0]{handle} }
sub observed { $_[0]{observed} }
sub sessions { $_[0]{sessions} }
sub stats {
    my ($s) = @_;
    return {
        received_frames => $s->{received_frames},
        receive_peak    => $s->{receive_peak},
        relay_frames    => $s->{relay_frames},
        direct_frames   => $s->{direct_frames},
        handle          => $s->{handle},
        observed        => $s->{observed},
    };
}

sub emit {
    my ($self, $ev) = @_;
    my $rec = { %$ev, t => time - $self->{started} };
    push @{ $self->{log} }, $rec;
    $self->{on_event}->($rec);
}

sub stop { $_[0]{running} = 0 }

# ------------------------------------------------------------------ transport

sub sendto {
    my ($self, $dest, $bytes) = @_;
    return 0 unless defined $dest && length $dest;
    if ($self->{via}) { $self->{via}->($dest, $bytes); return 1 }
    my ($ip, $port) = split /:/, $dest, 2;
    return 0 unless defined $port;
    $self->{sock}->send($bytes, 0, scalar sockaddr_in($port, inet_aton($ip)));
    return 1;
}

# Used by Cantus::NatSim to deliver inbound datagrams.
sub inject {
    my ($self, $bytes, $src) = @_;
    $self->handle_datagram($bytes, $src);
}

sub _relay_send {
    my ($self, $route, $name, $inner) = @_;
    $self->sendto($self->{relay}, Cantus::Wire::relay_encode($route, $inner, $name));
}

# -------------------------------------------------------------------- timers

sub after {
    my ($self, $delay, $cb, $tag) = @_;
    my $id = ++$self->{timer_seq};
    push @{ $self->{timers} }, { at => time + $delay, cb => $cb, tag => $tag, id => $id };
    return $id;
}

sub cancel {
    my ($self, $tag) = @_;
    @{ $self->{timers} } = grep { ($_->{tag} // '') ne $tag } @{ $self->{timers} };
}

sub next_time {
    my ($self) = @_;
    my ($min) = sort { $a <=> $b } map { $_->{at} } @{ $self->{timers} };
    return $min;
}

sub fire_timers {
    my ($self) = @_;
    my $now = time;
    my @due = grep { $_->{at} <= $now } @{ $self->{timers} };
    return unless @due;
    @{ $self->{timers} } = grep { $_->{at} > $now } @{ $self->{timers} };
    for my $t (sort { $a->{at} <=> $b->{at} } @due) { eval { $t->{cb}->() }; }
}

# See Cantus::Pump and spec §15: pump(0) drains timers, ticks and queued
# datagrams without waiting; pump($t) serves for at most $t; pump() is one
# default slice.  Timers and media ticks are served in every mode, including a
# drain, because a drain is a loop iteration, not a no-op.
sub pump {
    my ($self, $seconds) = @_;
    my $until = Cantus::Pump::deadline($seconds);
    my $drain = Cantus::Pump::is_drain($seconds);
    my $sel = IO::Select->new($self->{sock});
    while ($self->{running}) {
        last if Cantus::Pump::expired($seconds, $until);
        $self->fire_timers;
        $self->keepalive_tick if time >= $self->{next_keepalive};
        $self->media_tick     if time >= $self->{next_media};
        my $wait = Cantus::Pump::MAX_WAIT;
        if (my $n = $self->next_time) {
            my $d = $n - time;
            $wait = $d if $d >= 0 && $d < $wait;
        }
        unless ($drain) {
            my $left = $until - time;
            $wait = $left if $left < $wait;
        }
        my @r = $sel->can_read($drain ? 0 : ($wait > 0 ? $wait : 0));
        last if Cantus::Pump::finished($seconds, \@r);
        $self->recv_one for @r;
    }
}

sub recv_one {
    my ($self) = @_;
    my $buf;
    my $peer = recv($self->{sock}, $buf, 65535, 0);
    return unless defined $peer && length $buf;
    my ($port, $iaddr) = sockaddr_in($peer);
    $self->handle_datagram($buf, inet_ntoa($iaddr) . ':' . $port);
}

# ---------------------------------------------------------------- datagrams

sub handle_datagram {
    my ($self, $buf, $src, $framed) = @_;
    my $kind = Cantus::Wire::kind($buf);
    return unless defined $kind;

    if ($kind == 0) {
        my ($type, $fields) = eval { Cantus::Wire::msg_decode($buf) };
        $self->emit({ kind => 'rx', msg => $type ? Cantus::Wire::type_name($type) : 'BAD',
                      src => $src, len => length $buf, err => $@ }) if $self->{debug};
        return unless $type && $fields;
        return unless $self->verify_message($type, $fields);
        $self->on_control($type, $fields, $src, $framed);
    }
    elsif ($kind == 1) {
        my $m = eval { Cantus::Wire::media_decode($buf) };
        $self->on_media($m, $src) if $m;
    }
    elsif ($kind == 2) {
        my $r = eval { Cantus::Wire::relay_decode($buf) };
        return unless $r;
        return if !defined $r->{inner} || !length $r->{inner};  # no nesting
        $self->handle_datagram($r->{inner}, $src, 1);
    }
}

# ------------------------------------------------------------------- signing

sub verify_message {
    my ($self, $type, $fields) = @_;
    return 1 unless $self->{require_sig};
    return 1 unless $SIGNED{ Cantus::Wire::type_name($type) };
    my $sig = $fields->{5} ? $fields->{5}[1] : undef;
    return 0 unless defined $sig;
    my %copy = %$fields;
    delete $copy{5};
    my $ok = $self->{ident}->verify($type, \%copy, $sig, $self->{secret});
    $self->emit({ kind => 'auth-fail', type => Cantus::Wire::type_name($type) }) unless $ok;
    return $ok;
}

sub make_message {
    my ($self, $type, $fields, $sign) = @_;
    $fields->{4} = Cantus::Wire::V(++$self->{nonce}) unless defined $fields->{4};
    if ($sign || $SIGNED{ Cantus::Wire::type_name($type) }) {
        $fields->{5} = Cantus::Wire::B($self->{ident}->sign($type, $fields));
    }
    return Cantus::Wire::msg_encode($type, $fields);
}

sub _limits_bytes {
    my ($self) = @_;
    my $out = '';
    my $l = $self->{limits};
    my %map = (1 => 'max_calls', 2 => 'max_streams', 3 => 'max_bitrate',
               4 => 'max_datagram', 5 => 'keepalive_ms', 6 => 'reach_ms');
    for my $id (sort { $a <=> $b } keys %map) {
        $out .= Cantus::Wire::varint_encode(($id << 3) | 0)
             .  Cantus::Wire::varint_encode($l->{ $map{$id} } // 0);
    }
    return $out;
}

sub _limits_decode {
    my ($bytes) = @_;
    my %l;
    my %map = (1 => 'max_calls', 2 => 'max_streams', 3 => 'max_bitrate',
               4 => 'max_datagram', 5 => 'keepalive_ms', 6 => 'reach_ms');
    my $pos = 0;
    while ($pos < length $bytes) {
        my $tag = Cantus::Wire::varint_decode($bytes, \$pos);
        my $id = $tag >> 3;
        my $v  = Cantus::Wire::varint_decode($bytes, \$pos);
        $l{ $map{$id} } = $v if $map{$id};
    }
    return \%l;
}

# --------------------------------------------------------------- candidates

sub candidates {
    my ($self) = @_;
    my $tok = Cantus::Reach::cand_token('self', 0);
    my @c;
    if ($self->{handle}) {
        push @c, { kind => 0, ip => $self->_obs_ip, port => $self->_obs_port,
                   priority => 100, token => $tok };
        my ($rip, $rport) = split /:/, $self->{relay}, 2;
        push @c, { kind => 0, ip => $rip, port => $rport, priority => 50, token => $tok };
    }
    else {
        my ($ip, $port) = split /:/, $self->{addr}, 2;
        push @c, { kind => 0, ip => $ip, port => $port, priority => 100, token => $tok };
    }
    return \@c;
}

sub _obs_ip   { my ($s) = @_; my ($ip) = split /:/, $s->{observed} // $s->{addr}, 2; return $ip }
sub _obs_port { my ($s) = @_; my (undef, $p) = split /:/, $s->{observed} // $s->{addr}, 2; return $p }

# ------------------------------------------------------------- registration

sub register {
    my ($self) = @_;
    return unless $self->{relay};
    my $f = {
        21 => Cantus::Wire::S('cantus/1'),
        11 => Cantus::Wire::S($self->{id}),
        1  => Cantus::Wire::S($self->{id}),
        24 => Cantus::Wire::B($self->{ident}->public_key),
        10 => Cantus::Wire::B($self->_limits_bytes),
    };
    $self->sendto($self->{relay}, $self->make_message(13, $f));
    $self->emit({ kind => 'register-sent', relay => $self->{relay} });
}

sub _schedule_refresh {
    my ($self) = @_;
    $self->cancel('register');
    $self->after(REFRESH, sub { $self->register }, 'register');
}

sub keepalive_tick {
    my ($self) = @_;
    $self->{next_keepalive} = time + T_KEEPALIVE;
    for my $s (values %{ $self->{sessions} }) {
        next unless $s->{accepted} && !$s->is_ended;
        my $f = {
            3 => Cantus::Wire::S($s->{call}),
            6 => Cantus::Wire::V($s->{gen}),
            16 => Cantus::Wire::V(int((time - $self->{started}) * 1000)),
        };
        $self->send_call_msg($s, 11, $f);
        if (time - ($s->{last_seen} // 0) > T_KEEPALIVE * 3) {
            $self->terminate($s, 'TRANSPORT_ERROR');
        }
    }
}

# ---------------------------------------------------------------- messaging

sub send_call_msg {
    my ($self, $s, $type, $f) = @_;
    $f->{3} //= Cantus::Wire::S($s->{call});
    $f->{6} //= Cantus::Wire::V($s->{gen});
    $f->{1} //= Cantus::Wire::S($self->{id});
    my $d = $self->make_message($type, $f);
    $self->emit({ kind => 'tx', msg => Cantus::Wire::type_name($type),
                  via => ($s->{reply} // 'relay'), route => $s->{reply_handle} // 0,
                  dest => ($s->{reply} // 'relay') eq 'direct' ? $s->{addr} : $self->{relay},
                  len => length $d }) if $self->{debug};
    if (($s->{reply} // 'relay') eq 'direct') {
        $self->sendto($s->{addr}, $d);
    }
    else {
        my $route = $s->{reply_handle} // 0;
        $self->_relay_send($route, $s->{peer}, $d);
    }
}

sub on_control {
    my ($self, $type, $f, $src, $framed) = @_;
    my %h;
    my $name = Cantus::Wire::type_name($type);
    my $method = {
        HELLO => '_on_hello', HELLO_ACK => '_on_hello_ack',
        INVITE => '_on_invite', RING => '_on_ring', ACCEPT => '_on_accept',
        REJECT => '_on_reject', TERMINATE => '_on_terminate',
        PATH => '_on_path', PATH_ACK => '_on_path_ack',
        FEEDBACK => '_on_feedback', PROBE => '_on_probe', INFO => '_on_info',
        REGISTER_ACK => '_on_register_ack',
    }->{$name} or return;
    my $m = $self->can($method) or return;
    $self->$m($f, $src, $framed);
}

sub _on_hello {
    my ($self, $f, $src) = @_;
    my $peer = $f->{1} ? $f->{1}[1] : undef;
    return unless defined $peer;
    $self->{peer_caps}{$peer} = eval { Cantus::Caps::decode($f->{9}[1]) } if $f->{9};
    return if $self->{hello_done}{$src}++;
    my $reply = {
        21 => Cantus::Wire::S('cantus/1'),
        1  => Cantus::Wire::S($self->{id}),
        24 => Cantus::Wire::B($self->{ident}->public_key),
        9  => Cantus::Wire::B(Cantus::Caps::encode(@{ $self->{caps} })),
        10 => Cantus::Wire::B($self->_limits_bytes),
    };
    $self->sendto($src, $self->make_message(2, $reply));
    $self->emit({ kind => 'hello', peer => $peer });
}

sub _on_hello_ack { }

sub _on_register_ack {
    my ($self, $f, $src) = @_;
    my $prev = $self->{observed};
    my $obs = $f->{19} ? $f->{19}[1] : undef;
    if (defined $obs) {
        my $pos = 0;
        Cantus::Wire::varint_decode($obs, \$pos);            # family
        my $l = Cantus::Wire::varint_decode($obs, \$pos);
        my $ip = substr($obs, $pos, $l);
        $pos += $l;
        my $port = Cantus::Wire::varint_decode($obs, \$pos);
        $self->{observed} = "$ip:$port";
    }
    $self->{handle} = $f->{15} ? $f->{15}[1] : 0;
    $self->{ready} = 1;
    $self->emit({ kind => 'registered', observed => $self->{observed}, handle => $self->{handle} });
    $self->_schedule_refresh;

    # Our public address moved (a rebinding).  Tell every call that is running
    # on the relay path where we now are, so its peer can probe us directly.
    if (defined $prev && defined $self->{observed} && $prev ne $self->{observed}) {
        for my $s (values %{ $self->{sessions} }) {
            next unless $s->is_active;
            next unless ($s->{committed} // '') eq 'relay';
            $self->_announce_path($s, 1);
            $self->_schedule_reprobe($s);
        }
    }
}

# -------------------------------------------------------------------- calls

sub route_for {
    my ($self, $ctx) = @_;
    my $router = $self->{router};
    return { matched => 1, route => 'auto', actions => [ { answer => {} } ] }
        unless $router;
    return $router->decide($ctx);
}

sub call {
    my ($self, $to, %opt) = @_;
    my $call = $opt{call} // unpack('H*', sha256($self->{id} . $to . rand() . time . $self->{nonce}++));
    $call = substr($call, 0, 32);
    my $s = Cantus::Session->new(
        call => $call, gen => $opt{gen} // 1, role => 'caller', peer => $to,
        tag => tag_for($call), caps_offer => [ @{ $self->{caps} } ], started => time,
    );
    if ($self->{handle}) {
        $s->{reply} = 'relay';
        $s->{reply_handle} = 0;    # name-addressed until the peer tells us more
    }
    elsif (my $p = $self->{peers}{$to}) {
        $s->{reply} = 'direct';
        $s->{addr}  = $p->{addr};
    }
    else {
        $self->emit({ kind => 'error', error => "no route to $to" });
        return undef;
    }
    $s->fire('invite_sent');
    $self->{sessions}{$call} = $s;
    my $f = {
        2  => Cantus::Wire::S($to),
        9  => Cantus::Wire::B(Cantus::Caps::encode(@{ $self->{caps} })),
        12 => Cantus::Wire::B(Cantus::Reach::cands_encode(@{ $self->candidates } )),
        15 => Cantus::Wire::V($self->{handle} // 0),
    };
    $self->send_call_msg($s, 3, $f);
    $self->emit({ kind => 'invite', call => $call, to => $to });
    $self->after(T_RING, sub {
        $self->terminate($s, 'TIMEOUT') unless $s->{accepted} || $s->is_ended;
    }, "ring:$call");
    return $call;
}

sub _on_invite {
    my ($self, $f, $src, $framed) = @_;
    my $call = $f->{3}[1] // return;
    my $gen  = $f->{6} ? $f->{6}[1] : 1;
    my $peer = $f->{1}[1] // return;

    if (my $dup = $self->{sessions}{$call}) {
        return;    # retransmission absorbed, section 7.4
    }
    my $s = Cantus::Session->new(
        call => $call, gen => $gen, role => 'callee', peer => $peer,
        tag => tag_for($call), started => time,
        caps_offer => eval { Cantus::Caps::decode($f->{9}[1]) } || [],
        peer_handle => $f->{15} ? $f->{15}[1] : 0,
    );
    $s->{cands} = eval { Cantus::Reach::cands_decode($f->{12}[1]) } || [];
    # The relay forwards a bare control message, so an INVITE that arrives from
    # the relay's own address must be answered through the relay.
    my $via_relay = $framed
        || (defined $self->{relay} && defined $src && $src eq $self->{relay})
        || !$self->{peers}{$peer};
    $s->{reply} = $via_relay ? 'relay' : 'direct';
    $s->{addr}  = $src;
    $s->{reply_handle} = $s->{peer_handle};
    $s->fire('invite_recv');
    $self->{sessions}{$call} = $s;
    $self->emit({ kind => 'incoming', call => $call, from => $peer });

    my $decision = $self->route_for({
        to => $self->{id}, from => $peer, verified => 1,
        calls => scalar(grep { $_->is_active } values %{ $self->{sessions} }),
    });
    my ($action, $arg) = %{ $decision->{actions}[0] };
    if ($action eq 'reject') {
        $self->reject($s, ref $arg ? 3 : ($arg // 3));
    }
    elsif ($action eq 'forward') {
        my $target = ref $arg ? $arg->{to} : $arg;
        $self->terminate($s, 'NORMAL');
        $self->call($target);
    }
    else {
        $self->after($self->{ring_delay}, sub { $self->_announce_ring($s) }, "ring-send:$call")
            if $self->{ring_delay};
        $self->accept($s) if $self->{auto_answer};
    }
}

sub _announce_ring {
    my ($self, $s) = @_;
    return if $s->is_ended;
    $s->fire('ring_sent');
    $self->send_call_msg($s, 4, {});
    $self->emit({ kind => 'ringing', call => $s->{call} });
}

sub accept {
    my ($self, $s) = @_;
    return if $s->{accepted} || $s->is_ended;
    my $agreed = Cantus::Caps::negotiate($s->{caps_offer}, [ @{ $self->{caps} } ]);
    unless ($agreed) {
        $self->reject($s, Cantus::Session::reason_id('NO_CAPABILITY'));
        return;
    }
    $s->{codec} = $agreed;
    $s->fire('accept_sent');
    $s->fire('ring_sent') if $s->state eq 'OFFERED' && 0;
    my $f = {
        9  => Cantus::Wire::B(Cantus::Caps::encode(@{ $self->{caps} })),
        12 => Cantus::Wire::B(Cantus::Reach::cands_encode(@{ $self->candidates })),
        15 => Cantus::Wire::V($self->{handle} // 0),
    };
    $self->send_call_msg($s, 5, $f);
    $self->emit({ kind => 'accepted', call => $s->{call}, codec => $agreed->{name} });
    $self->_start_reach($s);
}

sub reject {
    my ($self, $s, $reason) = @_;
    return if $s->is_ended;
    $s->fire('reject');
    my $f = { 7 => Cantus::Wire::V($reason // 3) };
    $self->send_call_msg($s, 6, $f);
    $self->emit({ kind => 'rejected', call => $s->{call},
                  reason => Cantus::Session::reason_name($reason // 3) });
    $self->after(T_TERMINATE, sub { delete $self->{sessions}{ $s->{call} } }, "linger:$s->{call}");
}

sub terminate {
    my ($self, $s, $reason) = @_;
    return if $s->is_ended;
    $s->fire('terminate');
    my $f = { 7 => Cantus::Wire::V(Cantus::Session::reason_id($reason)) };
    $self->send_call_msg($s, 7, $f);
    $self->emit({ kind => 'ended', call => $s->{call}, reason => $reason });
    $self->cancel("reach:$s->{call}");
    $self->cancel("ring:$s->{call}");
    $self->after(T_TERMINATE, sub { delete $self->{sessions}{ $s->{call} } }, "linger:$s->{call}");
}

sub _on_ring {
    my ($self, $f) = @_;
    my $s = $self->{sessions}{ $f->{3}[1] // '' } or return;
    $s->fire('ring_recv');
    $self->emit({ kind => 'ringing', call => $s->{call}, peer => 1 });
}

sub _on_accept {
    my ($self, $f) = @_;
    my $s = $self->{sessions}{ $f->{3}[1] // '' } or return;
    return if $s->{accepted};
    my $answer = eval { Cantus::Caps::decode($f->{9}[1]) } || [];
    my $agreed = Cantus::Caps::negotiate($s->{caps_offer}, $answer);
    unless ($agreed) {
        $self->terminate($s, 'NO_CAPABILITY');
        return;
    }
    $s->{codec} = $agreed;
    $s->{peer_handle} = $f->{15} ? $f->{15}[1] : $s->{peer_handle};
    $s->{cands} = eval { Cantus::Reach::cands_decode($f->{12}[1]) } || [];
    $s->fire('accept_recv');
    $self->cancel("ring:$s->{call}");
    $self->emit({ kind => 'accepted', call => $s->{call}, codec => $agreed->{name}, peer => 1 });
    $self->_start_reach($s);
}

sub _on_reject {
    my ($self, $f) = @_;
    my $s = $self->{sessions}{ $f->{3}[1] // '' } or return;
    my $reason = $f->{7} ? $f->{7}[1] : 3;
    $s->fire('reject');
    $self->emit({ kind => 'rejected', call => $s->{call}, peer => 1,
                  reason => Cantus::Session::reason_name($reason) });
    $self->after(T_TERMINATE, sub { delete $self->{sessions}{ $s->{call} } }, "linger:$s->{call}");
}

sub _on_terminate {
    my ($self, $f) = @_;
    my $s = $self->{sessions}{ $f->{3}[1] // '' } or return;
    my $reason = $f->{7} ? $f->{7}[1] : 0;
    return if $s->is_ended;
    $s->fire('terminate');
    $self->emit({ kind => 'ended', call => $s->{call}, peer => 1,
                  reason => Cantus::Session::reason_name($reason) });
    $self->cancel("reach:$s->{call}");
    $self->after(T_TERMINATE, sub { delete $self->{sessions}{ $s->{call} } }, "linger:$s->{call}");
}

# -------------------------------------------------------------------- Reach

sub _start_reach {
    my ($self, $s) = @_;
    my $call = $s->{call};
    $s->{challenge} = Cantus::Reach::challenge($call, $s->{gen});
    for my $delay (0, 0.100, 0.200) {
        $self->after($delay, sub { $self->_probe($s) }, "probe:$call");
    }
    $self->after(T_REACH, sub {
        return if $s->{committed} || $s->is_ended;
        # No direct path confirmed in time: use the relay path, which was
        # opened at registration.  This is a success, not a failure.
        $self->commit_path($s, 'relay');
        $self->_announce_path($s, 1);
    }, "reach:$call");
}

sub _probe {
    my ($self, $s) = @_;
    return unless $s->{accepted} && !$s->is_ended;
    my $f = {
        3  => Cantus::Wire::S($s->{call}),
        6  => Cantus::Wire::V($s->{gen}),
        14 => Cantus::Wire::V(0),
        13 => Cantus::Wire::B($s->{challenge}),
        16 => Cantus::Wire::V(int((time - $self->{started}) * 1000)),
    };
    my $d = $self->make_message(8, $f, 1);
    for my $c (@{ $s->{cands} }) {
        next unless $c->{ip} && $c->{port};
        $self->emit({ kind => 'probe-sent', call => $s->{call},
                      to => Cantus::Reach::addr($c), prio => $c->{priority} })
            if $self->{debug};
        $self->sendto(Cantus::Reach::addr($c), $d);
    }
}

sub _announce_path {
    my ($self, $s, $path) = @_;
    # An announcement is not a probe: it carries no challenge, so the receiver
    # must never read the source address as a path.  A relayed announcement
    # arrives from the relay, and treating that as peer evidence is exactly how
    # a call would start sending audio to a relay by mistake.
    my $f = { 14 => Cantus::Wire::V($path) };
    # A fallback announcement carries our *current* candidates, because after a
    # rebinding the old ones are dead.  This is what lets the peer re-probe and
    # lets the call return to a direct path.
    if ($path == 1) {
        my $c = $self->candidates;
        $f->{12} = Cantus::Wire::B(Cantus::Reach::cands_encode(@$c));
        $self->emit({ kind => 'announce', call => $s->{call}, observed => $self->{observed},
                      cands => join(',', map { Cantus::Reach::addr($_) } @$c) })
            if $self->{debug};
    }
    $self->send_call_msg($s, 8, $f);
}

sub _via_relay_source {
    my ($self, $src) = @_;
    return defined $self->{relay} && defined $src && $src eq $self->{relay};
}

# Section 8.7: retry the direct path in the background while the relay carries
# audio, so recovery never costs a second of silence.
sub _schedule_reprobe {
    my ($self, $s) = @_;
    my $call = $s->{call};
    $self->cancel("reprobe:$call");
    for my $delay (0.1, 0.6, 1.6, 4.0) {
        $self->after($delay, sub {
            return if $s->is_ended;
            return if ($s->{committed} // '') eq 'direct';
            # Re-state where we are on every wave: an announcement can be lost
            # while the peer is itself re-registering, and recovery must not
            # depend on a single message arriving.
            $self->_announce_path($s, 1);
            $self->_probe($s);
        }, "reprobe:$call");
    }
}

sub _on_path {
    my ($self, $f, $src) = @_;
    my $s = $self->{sessions}{ $f->{3}[1] // '' } or return;
    my $path = $f->{14} ? $f->{14}[1] : 1;
    if ($path == 0) {
        my $tok = $f->{13} ? $f->{13}[1] : '';
        if (!length $tok) {
            # Announcement only: the peer is direct and wants us to come back.
            $s->{peer_path} = 'direct';
            $self->_probe($s);
            $self->_schedule_reprobe($s);
            return;
        }
        $self->emit({ kind => 'probe-rx', call => $s->{call}, src => $src,
                      ok => (defined $s->{challenge} && $tok eq $s->{challenge}) ? 1 : 0 })
            if $self->{debug};
        return unless defined $s->{challenge} && $tok eq $s->{challenge};
        # A probe that arrived from the relay proves nothing about a direct
        # path, so it only counts when it came from somewhere else.
        return if $self->_via_relay_source($src);
        # A verified probe from the peer's own address: direct works.
        $s->{peer_addr} = $src;
        $s->{direct_ok} = 1;
        my $was = $s->{committed};
        if (!$was || $was eq 'relay') {
            $self->commit_path($s, 'direct');
            # Tell the peer to come back too; its probes may be lagging ours.
            $self->_announce_path($s, 0) if $was;
        }
        # Answer the probe *on the path it arrived by*.  A PATH_ACK sent through
        # the relay would come back from the relay's address, which proves
        # nothing about a direct path (and is refused for that reason).
        my $ack = {
            3  => Cantus::Wire::S($s->{call}),
            6  => Cantus::Wire::V($s->{gen}),
            1  => Cantus::Wire::S($self->{id}),
            14 => Cantus::Wire::V(0),
            13 => Cantus::Wire::B($tok),
        };
        $self->sendto($src, $self->make_message(9, $ack, 1));
    }
    else {
        # A fallback announcement that arrives late must not pull a working
        # direct path back to the relay: if audio is still arriving *directly*,
        # the announcement is stale and is ignored.  Media arriving over the
        # relay is not evidence about the direct path -- treating it as such
        # makes the peer's fallback wait out the report only, for no reason.
        if (($s->{committed} // '') eq 'direct'
            && time - ($s->{last_direct_media} // 0) < 0.5) {
            return;
        }
        $s->{peer_path} = 'relay';
        my $changed = 0;
        if ($f->{12}) {
            my $fresh = eval { Cantus::Reach::cands_decode($f->{12}[1]) };
            # Adopt the peer's new addresses.  Do not *announce* in response:
            # two peers announcing at each other would push the fallback back
            # and forth and never converge.
            if ($fresh && @$fresh) {
                my $before = join(',', map { Cantus::Reach::addr($_) } @{ $s->{cands} || [] });
                my $after  = join(',', map { Cantus::Reach::addr($_) } @$fresh);
                $changed = $before ne $after;
                $s->{cands} = $fresh;
            }
        }
        # Using the relay is always safe, so a peer that says it has fallen back
        # is believed immediately; the probes decide when to come back.
        $self->commit_path($s, 'relay');
        # The peer's probes cannot reach us until we have sent something to its
        # new address: that outbound packet is what opens the mapping its
        # return path needs.  When only one endpoint rebinds, the far side never
        # loses media itself, so it must punch that hole when told about the new
        # address -- otherwise recovery waits on a probe that can never arrive.
        if ($changed) {
            $self->_probe($s);
            $self->_schedule_reprobe($s);
        }
    }
}

sub _on_path_ack {
    my ($self, $f, $src) = @_;
    my $s = $self->{sessions}{ $f->{3}[1] // '' } or return;
    my $path = $f->{14} ? $f->{14}[1] : 1;
    $s->{peer_path} = $path ? 'relay' : 'direct';
    if ($path == 0) {
        return if $self->_via_relay_source($src);
        $s->{peer_addr} = $src;
        $self->commit_path($s, 'direct');
    }
    else {
        $self->commit_path($s, 'relay') unless $s->{committed};
    }
}

sub commit_path {
    my ($self, $s, $path) = @_;
    my $prev = $s->{committed};
    return if $prev && $prev eq $path;
    # Reception evidence belongs to the path it was gathered on, so a commit
    # clears the stall counter: reports arriving before this path existed must
    # not be read as a break on it.
    $s->{fb_stall} = 0;
    $s->{committed} = $path;
    $s->commit_path($path);
    $self->cancel("reach:$s->{call}") unless $prev;
    $self->cancel("reprobe:$s->{call}") if $path eq 'direct';
    $self->emit({ kind => 'path', call => $s->{call}, path => $path,
                  switch => ($prev ? 1 : 0),
                  from => $prev, ms => int((time - $s->{started}) * 1000) });
}

# -------------------------------------------------------------------- media

sub media_tick {
    my ($self) = @_;
    my $now = time;
    # Keep the 20 ms cadence even when the event loop is busy: send the frames
    # that are due, but never a burst large enough to be a spike.
    my $sent = 0;
    while ($now >= $self->{next_media} && $sent < 5) {
        for my $s (values %{ $self->{sessions} }) {
            next unless $s->is_active;
            $self->_send_media($s);
        }
        $self->{next_media} += MEDIA_TICK;
        $sent++;
    }
    $self->{next_media} = $now + MEDIA_TICK if $self->{next_media} < $now - 1;

    for my $s (values %{ $self->{sessions} }) {
        next unless $s->is_active;
        if ($now >= ($s->{next_feedback} // 0)) {
            $s->{next_feedback} = $now + FEEDBACK;
            $self->_send_feedback($s);
            $self->_check_rebinding($s);
        }
    }
}

sub _send_media {
    my ($self, $s) = @_;
    my $ptime = $s->{codec} ? $s->{codec}{ptime} : 20;
    my $n = Cantus::Media::frame_samples($ptime, $s->{codec} ? $s->{codec}{rate} : 8000);
    my ($payload, $phase) = Cantus::Media::pcm_frame(
        hz => $self->{tone_hz}, samples => $n, phase => $s->{phase} // 0,
    );
    $s->{phase} = $phase;
    my $m = Cantus::Wire::media_encode(
        stream => 0, tag => $s->{tag}, seq => $s->{seq}++, ts => ($s->{ts} // 0),
        codec => 2, flags => 0, payload => $payload,
    );
    $s->{ts} = ($s->{ts} // 0) + $n;
    if (($s->{committed} // '') eq 'direct' && $s->{peer_addr}) {
        $self->sendto($s->{peer_addr}, $m);
        $s->{sent}++;
    }
    elsif ($s->{committed}) {
        $self->_relay_send($s->{peer_handle} // 0, $s->{peer}, $m);
        $s->{sent}++;
    }
}

sub on_media {
    my ($self, $m, $src) = @_;
    my ($s) = grep { ($_->{tag} // -1) == $m->{tag} && $_->is_active }
              values %{ $self->{sessions} };
    return unless $s;
    my $seq = $m->{seq} // 0;
    $s->{received}++;
    $s->{last_media} = time;
    $s->{last_seen}  = time;
    # Media that arrived through the relay says nothing about the direct path,
    # so liveness for fallback announcements is tracked separately.
    $s->{last_direct_media} = time unless $self->_via_relay_source($src);
    $s->{recv_bytes_iv} = ($s->{recv_bytes_iv} // 0) + length($m->{payload} // '');
    if (!defined $s->{recv_high}) {
        $s->{recv_high} = $seq;
    }
    elsif ($seq > $s->{recv_high}) {
        # Sequence gaps are lost media.  Before the first frame there is no
        # baseline, so nothing is counted as lost.
        my $gap = $seq - $s->{recv_high} - 1;
        if ($gap > 0 && $gap < 10_000) {
            $s->{lost_iv} = ($s->{lost_iv} // 0) + $gap;
            $s->{frames_lost} = ($s->{frames_lost} // 0) + $gap;
        }
        $s->{recv_high} = $seq;
    }
    my $peak = Cantus::Media::peak($m->{payload});
    $s->{peak} = $peak if $peak > ($s->{peak} // 0);
    $self->{received_frames}++;
    $self->{receive_peak} = $peak if $peak > $self->{receive_peak};
    # Classified by where the packet came from, not by which path we happen to
    # be committed to: a frame the relay forwarded is relay traffic even if we
    # had already switched back to direct when it landed.
    if ($self->_via_relay_source($src)) { $self->{relay_frames}++ }
    else { $self->{direct_frames}++ }
}

# Section 9.5.  The report is not decoration: `recv_high` is the only way a
# sender can learn that its own packets are not landing, because no local
# counter can tell the difference between "sent" and "received".
sub _send_feedback {
    my ($self, $s) = @_;
    my $now     = time;
    my $elapsed = $now - ($s->{fb_iv_start} // $s->{started} // $now);
    $elapsed = 0.001 if $elapsed <= 0;
    my $got  = $s->{received}  - ($s->{fb_received_base} // 0);
    my $lost = $s->{lost_iv} // 0;
    my $kbps = int(($s->{recv_bytes_iv} // 0) * 8 / 1000 / $elapsed);
    my $loss_q8 = ($got + $lost) > 0 ? int(256 * $lost / ($got + $lost)) : 0;
    my $report = Cantus::Media::report_encode(
        loss_q8     => $loss_q8,
        rtt_us      => 0,
        jitter_us   => 0,
        recv_kbps   => $kbps,
        desired_kbps => 24,
        frames_lost => $lost,
        recv_high   => $s->{recv_high} // 0,
    );
    $self->send_call_msg($s, 10, { 23 => Cantus::Wire::B($report) });
    $s->{fb_iv_start}      = $now;
    $s->{fb_received_base} = $s->{received};
    $s->{recv_bytes_iv}    = 0;
    $s->{lost_iv}          = 0;
}

sub _on_feedback {
    my ($self, $f, $src) = @_;
    my $s = $self->{sessions}{ $f->{3}[1] // '' } or return;
    my $r = Cantus::Media::report_decode($f->{23}[1] // '');
    $s->{fb_peer} = $r;
    $s->{fb_at}   = time;
    $s->{last_seen} = time;
    # Track whether the peer's reception of *our* media is advancing.  Two
    # consecutive reports at the same high-water mark, while we keep sending,
    # means our committed path is not delivering anything.
    if (defined $r->{recv_high}) {
        my $sent = ($s->{seq} // 0);
        if (defined $s->{fb_high} && $r->{recv_high} <= $s->{fb_high}
            && $sent - $s->{fb_high} >= SEND_STALL) {
            $s->{fb_stall} = ($s->{fb_stall} // 0) + 1;
            $s->{fb_stall_at} //= time;
        }
        else {
            $s->{fb_stall}    = 0;
            $s->{fb_stall_at} = undef;
        }
        $s->{fb_high} = $r->{recv_high}
            if !defined $s->{fb_high} || $r->{recv_high} > $s->{fb_high};
    }
}

# Section 8.7: a committed direct path that has stopped delivering means the
# mapping moved.  Three things can reveal that, in order of how fast they are:
#
#   report    the peer's own report says it is receiving nothing we send, while
#             we are still receiving fine -- invisible to every local counter
#   silence   we hear nothing, but the peer is still reporting, so it is alive
#   net       nothing at all arrives for T_REBIND; never wait longer than this
#
# The first two cut the outage from seconds to a few hundred milliseconds; the
# third is what keeps a half-dead path from hanging the call indefinitely.
sub _check_rebinding {
    my ($self, $s) = @_;
    return unless ($s->{committed} // '') eq 'direct';
    return if $s->is_ended;
    my $now  = time;
    my $idle = $now - ($s->{last_media} || $s->{started} || $now);
    my $fb_age = defined $s->{fb_at} ? $now - $s->{fb_at} : undef;

    my $trigger;
    if (($s->{fb_stall} // 0) >= 2 && ($s->{fb_high} // 0) > 0
        && defined $s->{fb_stall_at} && $now - $s->{fb_stall_at} >= T_REBIND_FAST) {
        # The peer keeps reporting, and keeps reporting the same high-water
        # mark: our media is going nowhere even if theirs still reaches us.  The
        # duration test keeps a report that was in flight during a path switch
        # from being read as a fresh break.
        $trigger = 'report';
    }
    elsif ($idle > T_REBIND_FAST && defined $fb_age && $fb_age < FB_LIVE) {
        # We hear nothing while the peer is demonstrably still talking to us.
        $trigger = 'silence';
    }
    elsif ($idle > T_REBIND) {
        $trigger = 'timer';
    }
    return unless $trigger;
    $self->emit({ kind => 'rebind', call => $s->{call}, after_ms => int($idle * 1000),
                  trigger => $trigger });
    # Refresh our mapping first: the relay must learn our new address before it
    # can carry audio to us.  This is a registration, not a call transition.
    $self->register if $self->{relay};
    $self->commit_path($s, 'relay');
    $self->_announce_path($s, 1);
    $self->_schedule_reprobe($s);
}

sub _on_probe {
    my ($self, $f, $src) = @_;
    $self->{last_probe} = time;
    $self->{peer_seen}  = $src;
}

sub _on_info {
    my ($self, $f, $src) = @_;
    my $s = $self->{sessions}{ $f->{3}[1] // '' } or return;
    if (($f->{18} ? $f->{18}[1] : 1) == 0) {
        $self->emit({ kind => 'dtmf', call => $s->{call}, digit => $f->{17}[1] });
    }
    else {
        $self->emit({ kind => 'info', call => $s->{call}, payload => $f->{17}[1] });
    }
}

sub send_dtmf {
    my ($self, $s, $digit) = @_;
    $self->send_call_msg($s, 12, {
        18 => Cantus::Wire::V(0),
        17 => Cantus::Wire::B($digit),
    });
}

sub hangup {
    my ($self, $call, $reason) = @_;
    my $s = $self->{sessions}{$call} or return;
    $self->terminate($s, $reason // 'NORMAL');
}

1;
