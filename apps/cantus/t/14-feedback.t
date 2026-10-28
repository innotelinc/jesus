use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/../lib";
use Test::More;
use Time::HiRes qw(time sleep);
use Cantus::Node;
use Cantus::Session;
use Cantus::Media;
use Cantus::Wire;

# The fast rebinding trigger has to work when the path breaks in a way no local
# counter can see: our own inbound media keeps arriving, but the peer reports
# that none of ours lands.  That is the whole reason the report carries a
# reception high-water mark.  This is a unit test of that decision, driven
# without a network so the timing assertions are deterministic.

# ---------------------------------------------------------------- report codec

my $blob = Cantus::Media::report_encode(
    loss_q8 => 12, rtt_us => 1500, jitter_us => 300, recv_kbps => 32,
    desired_kbps => 24, frames_lost => 7, recv_high => 12_345,
);
my $r = Cantus::Media::report_decode($blob);

is($r->{recv_high}, 12_345, 'the report carries the highest media sequence received');
is($r->{frames_lost}, 7, 'the report carries the loss count');
is($r->{loss_q8}, 12, 'the report carries the loss fraction');
is($r->{recv_kbps}, 32, 'the report carries the received bitrate');

# A 1.0 peer sends six fields.  A missing tail must decode, not die.
my $legacy = join('', map { Cantus::Wire::varint_encode($_) } (0, 0, 0, 32, 24, 3));
my $old = Cantus::Media::report_decode($legacy);
is($old->{frames_lost}, 3, 'a six-field report still decodes');
ok(!exists $old->{recv_high}, 'a six-field report has no reception mark to act on');

# ------------------------------------------------------------------- harness

sub active_session {
    my ($node, $call, %a) = @_;
    my $s = Cantus::Session->new(
        call => $call, gen => 1, role => 'caller', peer => 'bob@test',
        tag => Cantus::Node::tag_for($call), caps_offer => [], started => time,
    );
    $s->fire('invite_sent');
    $s->fire('accept_recv');
    $s->commit_path('direct');
    $s->{received}          = 50;
    $s->{recv_high}         = 50;
    $s->{seq}               = $a{seq} // 200;
    $s->{last_media}        = $a{last_media} // time;
    $s->{last_direct_media} = $a{last_media} // time;
    $node->{sessions}{$call} = $s;
    return $s;
}

# A real FEEDBACK datagram, encoded and decoded, so the test exercises the
# wire format rather than a hand-built field hash.
sub report_from_peer {
    my ($node, $call, %r) = @_;
    my $dgram = $node->make_message(10, {
        3  => Cantus::Wire::S($call),
        23 => Cantus::Wire::B(Cantus::Media::report_encode(%r)),
    }, 0);
    my (undef, $fields) = Cantus::Wire::msg_decode($dgram);
    $node->_on_feedback($fields, '127.0.0.1:4000');
}

sub triggers {
    my ($node) = @_;
    return join(',', map { $_->{trigger} // '-' }
                     grep { ($_->{kind} // '') eq 'rebind' } @{ $node->{log} });
}

my $node = Cantus::Node->new(
    id => 'alice@test', secret => 'test', relay => '127.0.0.1:9',
    on_event => sub { },
);

# ------------------------------------- the peer reports that nothing arrives

my $s = active_session($node, 'stalled', seq => 200);

# The peer confirms having received up to frame 150 while we are at 200: the
# gap alone is normal in-flight media, not a fault.
report_from_peer($node, 'stalled', recv_kbps => 0, recv_high => 150, frames_lost => 0);
$node->_check_rebinding($s);
is($s->{committed}, 'direct', 'a single report that lags is not a break');

report_from_peer($node, 'stalled', recv_kbps => 0, recv_high => 150, frames_lost => 10);
$node->_check_rebinding($s);
is($s->{committed}, 'direct', 'a repeated reception mark is still not immediate failover');

report_from_peer($node, 'stalled', recv_kbps => 0, recv_high => 150, frames_lost => 20);
$node->_check_rebinding($s);
is($s->{committed}, 'direct', 'the stall must persist for the detection window');

sleep 0.45;
$node->_check_rebinding($s);
is($s->{committed}, 'relay',
    'a peer reporting no reception fails the path over even though our inbound is fine');
is(triggers($node), 'report', 'the failover was triggered by the peer report, not the 2000 ms timer');

# ------------------------------------------- the peer reports media arriving

my $ok_node = Cantus::Node->new(
    id => 'alice@test', secret => 'test', relay => '127.0.0.1:9',
    on_event => sub { },
);
my $live = active_session($ok_node, 'arriving', seq => 200);
for my $high (150, 160, 170) {
    report_from_peer($ok_node, 'arriving', recv_kbps => 32, recv_high => $high, frames_lost => 0);
}
$live->{last_media} = $live->{last_direct_media} = time;
$ok_node->_check_rebinding($live);
is($live->{committed}, 'direct', 'advancing reception keeps the direct path');

sleep 0.45;
report_from_peer($ok_node, 'arriving', recv_kbps => 32, recv_high => 200, frames_lost => 0);
$live->{last_media} = $live->{last_direct_media} = time;
$ok_node->_check_rebinding($live);
is($live->{committed}, 'direct', 'a healthy path is never abandoned');

# ------------------------------------------ the timer is still there as a net

my $dead_node = Cantus::Node->new(
    id => 'alice@test', secret => 'test', relay => '127.0.0.1:9',
    on_event => sub { },
);
my $quiet = active_session($dead_node, 'silent', last_media => time - 2.2);
$dead_node->_check_rebinding($quiet);
is($quiet->{committed}, 'relay',
    'with no report to corroborate, the 2000 ms safety net still fails over');
is(triggers($dead_node), 'timer', 'and it reports that it was the timer');

# Fast silence detection: half a second of nothing while the peer is still
# reporting is already decisive.
my $silent = Cantus::Node->new(
    id => 'alice@test', secret => 'test', relay => '127.0.0.1:9',
    on_event => sub { },
);
my $half = active_session($silent, 'half', last_media => time - 0.45);
report_from_peer($silent, 'half', recv_kbps => 32, recv_high => 150, frames_lost => 0);
$silent->_check_rebinding($half);
is($half->{committed}, 'relay',
    'half a second of silence with a live peer is enough to fail over');
is(triggers($silent), 'silence', 'and it reports silence as the reason');

done_testing();
