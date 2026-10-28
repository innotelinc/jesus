use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/../lib";
use Test::More;
use Cantus::Scenario;

# A rebinding does not have to hit both ends.  Here exactly one middlebox is
# flushed, so exactly one side loses its public address.  The far side keeps a
# working mapping of its own, which is precisely the trap: it never loses media
# of its own accord, so unless it opens a mapping toward the peer's new address
# the rebound side's probes are dropped as unsolicited and recovery never comes.
#
# Each scenario asserts the call is never torn down and that a direct path is
# restored afterwards; the symmetric case documents the case where no direct
# path can exist and the relay has to keep carrying the call.

sub run_one {
    my ($side) = @_;
    my $scenario = Cantus::Scenario->new(nat => 'cone', trace => sub { });
    my $r = $scenario->run(
        media_seconds  => 8,
        rebind_at      => 0.5,
        rebind_sides   => [ $side ],
    );
    return ($scenario, $r);
}

sub history {
    my ($r) = @_;
    return join(', ', map { sprintf('%.2fs %s %s', $_->{t}, $_->{who}, $_->{path}) }
                     @{ $r->{path_history} });
}

for my $side (qw(alice bob)) {
    my $who = $side eq 'alice' ? 'caller' : 'callee';
    my ($scenario, $r) = run_one($side);

    ok($r->{ok}, "$who-only rebinding: the call kept audio")
        or diag explain { map { $_ => $r->{$_} } qw(frames peak path error) };

    is($r->{rebinds}, 1, "$who-only rebinding: exactly one middlebox was flushed");
    is_deeply($r->{rebind_sides}, [ $side ],
        sprintf('%s-only rebinding: only the %s NAT table moved', $who, $who));

    ok($r->{fell_back}, "$who-only rebinding: the direct path broke and the relay took over")
        or diag 'path history: ' . history($r);

    ok(defined $r->{recovered_at}, "$who-only rebinding: the call came back to a direct path")
        or diag 'path history: ' . history($r);

    is($r->{premature_end}, 0, "$who-only rebinding: the call was never torn down");
    is($r->{active_at_end}, 1, "$who-only rebinding: both endpoints still ACTIVE at hangup");

    my $after = $r->{frames} - ($r->{frames_at_recovery} // 0);
    cmp_ok($after, '>', 5, "$who-only rebinding: audio continued after recovery ($after frames)");

    # Detection is sub-second: the peer's reports and our own reception catch
    # the break, so the 2000 ms timer is a net rather than the mechanism.
    cmp_ok($r->{detect_ms} // 99_999, '<', 1000,
        sprintf('%s-only rebinding: break detected in %d ms, not on the 2000 ms timer',
                $who, $r->{detect_ms} // -1));

    # The outage is bounded by that detection window, not indefinite: a call that
    # only ever recovered by accident would show a gap running to the end.
    cmp_ok($r->{max_gap}, '<', 1.5,
        sprintf('%s-only rebinding: silence was bounded (%.2fs gap, %.2fs in)',
                $who, $r->{max_gap}, $r->{gap_at} // 0));

    is($r->{codec}, 'pcm-s16/8000/1', "$who-only rebinding: codec never renegotiated");
    ok($r->{ended}, "$who-only rebinding: the call still ends cleanly");
}

# No direct path can survive this: the rebound endpoint is behind a NAT that
# allocates a different public port per destination, so no candidate address
# describes it.  The requirement there is not recovery but continuity -- the
# relay carries the whole call and nothing is torn down.
{
    my $scenario = Cantus::Scenario->new(nat => 'symmetric', trace => sub { });
    my $r = $scenario->run(media_seconds => 6, rebind_at => 0.5, rebind_sides => ['alice']);

    ok($r->{ok}, 'symmetric caller-only rebinding: audio kept flowing over the relay');
    is($r->{rebinds}, 1, 'symmetric caller-only rebinding: one middlebox was flushed');
    is($r->{premature_end}, 0, 'symmetric caller-only rebinding: the call was never torn down');
    is($r->{active_at_end}, 1, 'symmetric caller-only rebinding: both endpoints still ACTIVE');
    is($r->{recovered_at}, undef,
        'symmetric caller-only rebinding: no phantom recovery is claimed');
    cmp_ok($r->{max_gap}, '<', 1.0,
        sprintf('symmetric caller-only rebinding: relay carried it continuously (%.2fs gap)', $r->{max_gap}));
}

done_testing();
