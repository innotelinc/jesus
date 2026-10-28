use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/../lib";
use Test::More;
use Cantus::Caps;

my @offer = (
    { name => 'pcm-s16/48000/1', ptime => 20, bitrate => 768, params => {} },
    { name => 'opus/48000/2',    ptime => 20, bitrate => 32,
      params => { useinbandfec => '1' } },
);
my @answer = (
    { name => 'opus/48000/1', ptime => 40, bitrate => 24, params => {} },
    { name => 'pcm-s16/48000/1', ptime => 20, bitrate => 768, params => {} },
    { name => 'opus/48000/2', ptime => 20, bitrate => 32,
      params => { maxaveragebitrate => '24000' } },
);

my $agreed = Cantus::Caps::negotiate(\@offer, \@answer);
is($agreed->{name}, 'pcm-s16/48000/1', 'caller order wins over callee preference');
is($agreed->{ptime}, 20, 'answerer transport constraint applied');
is(Cantus::Caps::codec_id($agreed->{name}), 2, 'codec id resolved');

my $agreed2 = Cantus::Caps::negotiate([ $offer[1] ], \@answer);
is($agreed2->{name}, 'opus/48000/2', 'opus selected when offered first');
is($agreed2->{params}{useinbandfec}, '1', 'offerer param retained');
is($agreed2->{params}{maxaveragebitrate}, '24000', 'answerer param merged');

is(Cantus::Caps::negotiate([ { name => 'red/48000/1', ptime => 20, params => {} } ], \@answer),
   undef, 'no common codec yields undef');

my $bytes = Cantus::Caps::encode(@offer);
my $back  = Cantus::Caps::decode($bytes);
is_deeply($back, \@offer, 'capability set round-trips exactly');
is(Cantus::Caps::encode(@$back), $bytes, 'encoding is canonical');

my @prod = Cantus::Caps::production_set();
is($prod[0]{name}, 'opus/48000/2', 'production set prefers stereo opus');
like(Cantus::Caps::describe(\@prod), qr/opus\/48000\/2/, 'describe renders the set');

done_testing();
