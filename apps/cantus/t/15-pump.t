use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/../lib";
use Test::More;
use Time::HiRes qw(time sleep);
use IO::Socket::INET;
use Socket qw(sockaddr_in inet_aton);
use Cantus::Pump;
use Cantus::Node;
use Cantus::Relay;
use Cantus::NatSim;
use Cantus::Wire;

# The pump contract (spec §15): every component answers the same three ways.
#
#   pump()            one default slice
#   pump(0)           drain what is queued, return at once
#   pump($seconds>0)  serve for at most $seconds
#
# This is not a style preference.  A caller that pumps five components with
# small non-zero budgets pays a scheduler tick per socket on hosts whose
# select() rounds timeouts up, throttles its own loop to ~20 Hz, and starves the
# busiest component.  The zero case is what makes the harness fast; if it ever
# regresses to "return immediately without reading", the relay goes quiet and
# every timing assertion in the suite becomes a coin flip.  So both halves are
# pinned here: drain returns fast, AND drain actually reads what is waiting.

# --------------------------------------------------------------- the helpers

is(Cantus::Pump::is_drain(0), 1, 'zero is the drain budget');
is(Cantus::Pump::is_drain(-1), 1, 'a negative budget drains too');
is(Cantus::Pump::is_drain(undef), 0, 'no argument is not a drain — it is one slice');
is(Cantus::Pump::is_drain(0.05), 0, 'a positive budget is a timed pump');
is(Cantus::Pump::budget(undef), Cantus::Pump::DEFAULT_SLICE, 'no argument means the default slice');
is(Cantus::Pump::wait_for(0, 0.01), 0, 'a drain never blocks in can_read');
cmp_ok(Cantus::Pump::wait_for(0.5, 0.25), '<=', Cantus::Pump::MAX_WAIT,
    'a timed pump caps a single can_read at MAX_WAIT');
is(Cantus::Pump::expired(0, time - 100), 0, 'a drain never expires: it ends when the sockets are empty');
is(Cantus::Pump::finished(0, []), 1, 'a drain with nothing ready is finished');
is(Cantus::Pump::finished(0, ['sock']), 0, 'a drain with something ready keeps going');

# ---------------------------------------------------------------- node: drain

my $node = Cantus::Node->new(
    id => 'pump@test', secret => 'pump-test', relay => '127.0.0.1:9',
    on_event => sub { },
);

my $fired = 0;
$node->after(0, sub { $fired++ }, 'pump-test');

my $t0 = time;
$node->pump(0);
my $drain = time - $t0;

is($fired, 1, 'a drain still serves due timers — it is a loop iteration, not a no-op');
cmp_ok($drain, '<', 0.080, sprintf('a drain returned in %.1f ms with nothing queued', $drain * 1000));

# ------------------------------------------------------- node: timed + default

$t0 = time;
$node->pump(0.05);
my $timed = time - $t0;

cmp_ok($timed, '>=', 0.040, sprintf('a timed pump honours its budget (%.0f ms)', $timed * 1000));
cmp_ok($timed, '<', 0.500, 'a timed pump does not overrun its budget');

$t0 = time;
$node->pump;
my $slice = time - $t0;

cmp_ok($slice, '>=', 0.005, sprintf('pump() serves one slice, not zero (%.0f ms)', $slice * 1000));
cmp_ok($slice, '<', 0.500, 'pump() returns — no argument is not "run forever"');

$node->stop;

# ------------------------------------------------------------- relay: drains

my $relay = Cantus::Relay->new(bind => '127.0.0.1:0', secret => 'pump-test', on_event => sub { });

my ($rip, $rport) = split /:/, $relay->addr, 2;
my $sock = IO::Socket::INET->new(
    PeerAddr => $rip, PeerPort => $rport, Proto => 'udp',
) or die "test socket: $!";

# Three datagrams addressed to a name the relay has never seen: each one is a
# drop, and each drop is proof that the datagram was read.
my $before = $relay->stats->{dropped};
my $inner  = $node->make_message(8, { 3 => Cantus::Wire::S('pump'), 6 => Cantus::Wire::V(1) }, 0);
$sock->send(Cantus::Wire::relay_encode(0, $inner, 'nobody@test')) for 1 .. 3;
sleep(0.02);    # let the three datagrams land in the receive queue

$t0 = time;
$relay->pump(0);
my $relay_drain = time - $t0;

is($relay->stats->{dropped} - $before, 3,
    'one drain read all three queued datagrams, not just the first');
cmp_ok($relay_drain, '<', 0.080,
    sprintf('the relay drain returned in %.1f ms', $relay_drain * 1000));

$t0 = time;
$relay->pump(0);
cmp_ok(time - $t0, '<', 0.080, 'an empty drain returns immediately');
is($relay->stats->{dropped}, $before + 3, 'and it reads nothing that is not there');
$relay->stop;

# ------------------------------------------------------------- natsim: drains

my $nat = Cantus::NatSim->new(mode => 'cone');
my ($nport, $niaddr) = sockaddr_in($nat->{cone}->sockname);
my $pub = IO::Socket::INET->new(
    PeerAddr => '127.0.0.1', PeerPort => $nport, Proto => 'udp',
) or die "test socket: $!";

# Two unsolicited packets at the public port: no mapping exists, so both count
# as dropped — which again only happens if they were read.
$pub->send('x' x 40) for 1 .. 2;
sleep(0.02);

$t0 = time;
$nat->pump(0);
my $nat_drain = time - $t0;

is($nat->stats->{dropped}, 2, 'a drain emptied the middlebox queue in one call');
cmp_ok($nat_drain, '<', 0.080, sprintf('the NAT drain returned in %.1f ms', $nat_drain * 1000));

done_testing();
