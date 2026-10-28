package Cantus::Session;
# The Cantus call object and its normative state machine.
# See spec/CANTUS-1.0.md section 7.
use strict;
use warnings;

my %LEGAL = (
    IDLE    => { invite_sent => 'OFFERED', invite_recv => 'OFFERED' },
    OFFERED => {
        ring_sent   => 'OFFERED',
        ring_recv   => 'RINGING',
        accept_sent => 'OFFERED',
        accept_recv => 'OFFERED',
        reject      => 'ENDED',
        terminate   => 'ENDED',
    },
    RINGING => {
        accept_sent => 'RINGING',
        accept_recv => 'RINGING',
        reject      => 'ENDED',
        terminate   => 'ENDED',
    },
    ACTIVE  => { terminate => 'ENDED' },
    ENDED   => {},
);

our @REASONS = qw(
    UNSPECIFIED BUSY NOT_FOUND REJECTED UNAVAILABLE TIMEOUT NO_CAPABILITY
    NOT_REACHABLE BAD_REQUEST GLARE AUTH_FAILED LIMIT CANCELLED NORMAL
    TRANSPORT_ERROR PATH_FAILED
);

my %REASON_ID;
@REASON_ID{@REASONS} = (0 .. $#REASONS);

sub reason_id   { my ($n) = @_; return $REASON_ID{$n} // 0 }
sub reason_name { my ($i) = @_; return $REASONS[$i] // 'UNKNOWN' }

sub new {
    my ($class, %a) = @_;
    return bless {
        call       => $a{call},
        gen        => $a{gen} // 1,
        role       => $a{role},                 # caller | callee
        peer       => $a{peer},
        state      => 'IDLE',
        accepted   => 0,
        committed  => undef,                    # direct | relay
        caps_offer => $a{caps_offer},
        caps_agree => undef,
        codec      => undef,
        tag        => $a{tag},
        peer_handle => $a{peer_handle},
        reply      => $a{reply},                # 'direct' | 'relay'
        reply_handle => $a{reply_handle},
        cands      => [],
        received   => 0,
        sent       => 0,
        last_media => 0,
        last_seen  => 0,
        high_nonce => {},
        hold       => 0,
        started    => $a{started},
        route      => $a{route},
    }, $class;
}

sub state { $_[0]{state} }

sub fire {
    my ($self, $event) = @_;
    my $next = $LEGAL{ $self->{state} }{$event};
    return 0 unless defined $next;
    $self->{state} = $next;
    $self->{accepted} = 1 if $event eq 'accept_sent' || $event eq 'accept_recv';
    return 1;
}

# Media is only flowing once a path is committed *and* the call was accepted.
sub commit_path {
    my ($self, $path) = @_;
    return 0 unless $self->{accepted};
    $self->{committed} = $path;
    $self->{state} = 'ACTIVE';
    return 1;
}

sub is_active { my ($self) = @_; return $self->{state} eq 'ACTIVE' }
sub is_ended  { my ($self) = @_; return $self->{state} eq 'ENDED' }

sub note_nonce {
    my ($self, $sender, $nonce) = @_;
    my $prev = $self->{high_nonce}{$sender} // -1;
    return 0 if $nonce <= $prev;
    $self->{high_nonce}{$sender} = $nonce;
    return 1;
}

1;
