use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/../lib";
use Test::More;
use Cantus::Session;

my $s = Cantus::Session->new(call => 'c1', role => 'caller', peer => 'bob@demo');
is($s->state, 'IDLE', 'starts IDLE');
ok($s->fire('invite_sent'), 'caller can invite');
is($s->state, 'OFFERED', 'INVITE moves to OFFERED');

is($s->commit_path('relay'), 0, 'cannot commit a path before ACCEPT');
is($s->state, 'OFFERED', 'state unchanged by rejected commit');

ok($s->fire('accept_recv'), 'ACCEPT accepted');
ok($s->commit_path('direct'), 'path commits after ACCEPT');
is($s->state, 'ACTIVE', 'call is ACTIVE');
ok($s->is_active, 'is_active');

ok($s->fire('terminate'), 'terminate from ACTIVE');
is($s->state, 'ENDED', 'call is ENDED');
ok($s->is_ended, 'is_ended');
ok(!$s->fire('terminate'), 'second TERMINATE is a no-op (idempotent)');
ok(!$s->fire('invite_recv'), 'illegal transition refused');

my $ring = Cantus::Session->new(call => 'c2', role => 'callee', peer => 'a@b');
$ring->fire('invite_recv');
is($ring->state, 'OFFERED', 'callee offer');
$ring->fire('ring_sent');
is($ring->state, 'OFFERED', 'RING does not change state');
$ring->fire('accept_sent');
ok($ring->commit_path('relay'), 'callee commits after accepting');
is($ring->state, 'ACTIVE', 'callee ACTIVE');

my $rej = Cantus::Session->new(call => 'c3', role => 'callee', peer => 'a@b');
$rej->fire('invite_recv');
$rej->fire('reject');
is($rej->state, 'ENDED', 'REJECT ends the call without a TERMINATE');

ok($s->note_nonce('peer', 5), 'fresh nonce accepted');
ok(!$s->note_nonce('peer', 5), 'replayed nonce refused');
ok(!$s->note_nonce('peer', 4), 'older nonce refused');
ok($s->note_nonce('peer', 6), 'newer nonce accepted');

is(Cantus::Session::reason_name(Cantus::Session::reason_id('GLARE')), 'GLARE',
   'reason codes round-trip');
is(Cantus::Session::reason_id('NORMAL'), 13, 'NORMAL is 13');

done_testing();
