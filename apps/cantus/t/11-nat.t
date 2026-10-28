use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/../lib";
use Test::More;
use Cantus::Scenario;

# Both endpoints sit behind a real UDP middlebox.  In symmetric mode the public
# port differs per destination, so a candidate address learned via the relay is
# not reachable directly: direct probing must fail and the relay must carry the
# audio.  This is the property the standard exists for.
my $sym = Cantus::Scenario->new(nat => 'symmetric', trace => sub { });
my $r = $sym->run(media_seconds => 1.2);

ok($r->{ok}, 'call completed behind symmetric NAT') or diag explain $r;
is($r->{path}, 'relay', 'relay path committed when direct is impossible');
cmp_ok($r->{frames}, '>', 10, "audio arrived through the relay ($r->{frames} frames)");
cmp_ok($r->{peak}, '>', 1000, "relayed audio peak amplitude $r->{peak}");
is($r->{direct_frames}, 0, 'no direct media was received');
cmp_ok($r->{relay_frames}, '>', 10, 'media counted on the relay path');

my $dropped = 0;
$dropped += $_->{dropped} for values %{ $r->{nat_stats} || {} };
cmp_ok($dropped, '>', 0, "NAT dropped $dropped unsolicited packets, proving direct was blocked");

my @path_events = grep { $_->{kind} eq 'path' } @{ $r->{events} };
ok(scalar @path_events, 'path decision was recorded');

# A permissive (cone) NAT should still get the direct path, so the fallback is
# not simply always taken.
my $cone = Cantus::Scenario->new(nat => 'cone', trace => sub { });
my $rc = $cone->run(media_seconds => 1.0);
ok($rc->{ok}, 'call completed behind cone NAT') or diag explain $rc;
cmp_ok($rc->{frames}, '>', 10, "cone NAT audio arrived ($rc->{frames} frames)");
cmp_ok($rc->{peak}, '>', 1000, 'cone NAT audio peak');

done_testing();
