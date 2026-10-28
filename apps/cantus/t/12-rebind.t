use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/../lib";
use Test::More;
use Cantus::Scenario;

# Both endpoints sit behind a real NAT whose UDP table is flushed mid-call:
# every mapping disappears and new public ports are allocated.  The direct path
# dies, Reach must move the audio to the relay, re-register to teach the relay
# the new addresses, then re-probe and come back to a direct path -- without the
# call ever ending.
my $scenario = Cantus::Scenario->new(nat => 'cone', trace => sub { });
my $r = $scenario->run(media_seconds => 9, rebind_at => 0.5);

ok($r->{ok}, 'call survived the rebinding with audio') or diag explain {
    map { $_ => $r->{$_} } qw(frames peak path fell_back recovered_at error)
};

is($r->{rebinds}, 2, 'both middleboxes were actually rebound mid-call');
is_deeply($r->{rebind_sides}, [ qw(alice bob) ], 'both NAT tables were flushed');

ok($r->{fell_back}, 'direct path broke, relay carried the call')
    or diag 'path history: ' . join(', ', map { "$_->{t}s $_->{who} $_->{path}" } @{ $r->{path_history} });

ok(defined $r->{recovered_at}, 'call returned to a direct path after the rebinding')
    or diag 'path history: ' . join(', ', map { "$_->{t}s $_->{who} $_->{path}" } @{ $r->{path_history} });

is($r->{premature_end}, 0, 'the call was never torn down during the outage');
is($r->{active_at_end}, 1, 'both endpoints were still ACTIVE when the test hung up');

my $after = $r->{frames} - ($r->{frames_at_recovery} // 0);
cmp_ok($after, '>', 5, "audio continued on the restored direct path ($after frames after recovery)");
ok($r->{recovered_at} < 9, 'recovery happened inside the media window');

# Fast detection: the outage is bounded by a sub-second decision, not by the
# 2000 ms safety net.
cmp_ok($r->{detect_ms} // 99_999, '<', 1000,
    sprintf('break detected in %d ms, not on the 2000 ms timer', $r->{detect_ms} // -1));
cmp_ok($r->{max_gap}, '<', 1.5,
    sprintf('the listener heard %.2fs of silence, down from over 2s', $r->{max_gap}));

# The relay is committed during the outage, but recovery is now probe-fast: the
# relay window is often shorter than one 20 ms media tick, so "frames delivered
# through the relay" would be a race, not a property.  What is asserted instead
# is that window being short -- the relay is a fallback, not a staging area.
# Media on the relay path is proven where the relay is the only path: t/11-nat.t.
cmp_ok($r->{relay_frames}, '<', 30,
    "recovery beat the relay ($r->{relay_frames} frames carried on it)");

# A rebinding must not be a teardown: the call id and codec survive.
is($r->{codec}, 'pcm-s16/8000/1', 'negotiated codec never renegotiated');
ok($r->{ended}, 'call still ends cleanly afterwards');

done_testing();
