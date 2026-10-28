use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/../lib";
use Test::More;
use Cantus::Scenario;

# A complete call with no middlebox: two endpoints, real sockets, real media.
my @events;
my $scenario = Cantus::Scenario->new(
    nat    => 'none',
    direct => 1,
    trace  => sub { push @events, $_[1] },
);
my $r = $scenario->run(media_seconds => 1.0);

ok($r->{ok}, 'call completed with audio') or diag explain $r;
is($r->{path}, 'direct', 'direct path chosen when nothing blocks it');
cmp_ok($r->{frames}, '>', 10, "received $r->{frames} media frames");
cmp_ok($r->{peak}, '>', 1000, "audio peak amplitude $r->{peak}");
is($r->{codec}, 'pcm-s16/8000/1', 'negotiated the loopback codec');
ok($r->{ended}, 'callee saw the call end');

my @kinds = map { $_->{kind} } @events;
ok((grep { $_ eq 'accepted' } @kinds), 'ACCEPT observed');
ok((grep { $_ eq 'path' } @kinds), 'path commitment observed');
ok((grep { $_ eq 'ended' } @kinds), 'termination observed');

my @paths = grep { $_->{kind} eq 'path' } @events;
cmp_ok($paths[0]{ms}, '<', 300, 'direct path confirmed inside the Reach deadline');

done_testing();
