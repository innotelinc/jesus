use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/../lib";
use Test::More;
use Cantus::Wire;

my @cases = (0, 1, 127, 128, 300, 16383, 16384, 2147483648,
             9007199254740992, 9223372036854775807);
for my $n (@cases) {
    my $enc = Cantus::Wire::varint_encode($n);
    my $pos = 0;
    is(Cantus::Wire::varint_decode($enc, \$pos), $n, "varint round-trip $n");
    is($pos, length $enc, "varint consumed all octets for $n");
}

eval { Cantus::Wire::varint_encode(-1) };
like($@, qr/negative/, 'negative varint rejected');

eval {
    my $bad = "\x80";
    my $pos = 0;
    Cantus::Wire::varint_decode($bad, \$pos);
};
like($@, qr/truncated/, 'truncated varint rejected');

eval {
    my $bad = "\x80" x 10;
    my $pos = 0;
    Cantus::Wire::varint_decode($bad, \$pos);
};
like($@, qr/longer than 9/, 'over-long varint rejected');

# unknown fields survive decode and re-encode identically
my $f = {
    1  => Cantus::Wire::S('alice@demo'),
    3  => Cantus::Wire::S('0123456789abcdef0123456789abcdef'),
    999 => Cantus::Wire::V(42),
};
my $d = Cantus::Wire::msg_encode(3, $f);
my ($type, $decoded) = Cantus::Wire::msg_decode($d);
is($type, 3, 'message type recovered');
is($decoded->{999}[1], 42, 'unknown field preserved');
is(Cantus::Wire::msg_encode($type, $decoded), $d, 're-encode is byte-identical');

# media framing carries the call tag and payload
my $m = Cantus::Wire::media_encode(
    stream => 0, tag => 0xBEEF, seq => 1000, ts => 48000,
    codec => 1, flags => 4, payload => 'payload-bytes',
);
my $md = Cantus::Wire::media_decode($m);
is($md->{tag}, 0xBEEF, 'media tag');
is($md->{seq}, 1000, 'media seq');
is($md->{ts}, 48000, 'media timestamp');
is($md->{payload}, 'payload-bytes', 'media payload');
is(Cantus::Wire::kind($m), 1, 'media kind');

# relay addressing by name and by handle
my $inner = Cantus::Wire::msg_encode(4, { 3 => Cantus::Wire::S('c') });
my $by_name = Cantus::Wire::relay_encode(0, $inner, 'bob@demo');
my $rn = Cantus::Wire::relay_decode($by_name);
is($rn->{route}, 0, 'relay name route');
is($rn->{name}, 'bob@demo', 'relay name');
is($rn->{inner}, $inner, 'relay inner preserved');
my $by_handle = Cantus::Wire::relay_encode(1001, $inner);
is(Cantus::Wire::relay_decode($by_handle)->{route}, 1001, 'relay handle route');

# signing input excludes the signature field
my $base = { 1 => Cantus::Wire::S('a@b'), 4 => Cantus::Wire::V(1) };
my $with_sig = { %$base, 5 => Cantus::Wire::B('fake') };
is(Cantus::Wire::signing_input(3, $base), Cantus::Wire::signing_input(3, $with_sig),
   'signature field excluded from digest');

# oversize datagrams are refused rather than fragmented
eval { Cantus::Wire::msg_encode(12, { 17 => Cantus::Wire::B('x' x 2000) }) };
like($@, qr/exceeds 1150/, 'oversize control message refused');

done_testing();
