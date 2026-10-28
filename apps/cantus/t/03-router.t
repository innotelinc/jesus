use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/../lib";
use Test::More;
use JSON::PP ();
use Cantus::Router;

my $doc = {
    version => 1,
    default => { reject => 3 },
    routes  => [
        {
            name => 'vip',
            when => { to => 'boss@example.net', verified => 1 },
            then => [ { answer => {} }, { bridge => { to => 'queue.vip' } } ],
        },
        {
            name => 'support-hours',
            when => { to => 'support@*', weekday => [ 'mon', 'tue', 'wed', 'thu', 'fri' ] },
            then => [ { answer => {} }, { bridge => { to => 'queue.support' } } ],
        },
        {
            name => 'night',
            when => { to => 'support@*' },
            then => [ { forward => { to => 'voicemail@example.net' } } ],
        },
    ],
};

my $r = Cantus::Router->new(doc => $doc);

my $d = $r->decide({ to => 'boss@example.net', from => 'a@b', verified => 1 });
is($d->{route}, 'vip', 'first matching route wins');
is(scalar @{ $d->{actions} }, 2, 'action chain returned');

$d = $r->decide({ to => 'boss@example.net', from => 'a@b', verified => 0 });
isnt($d->{route}, 'vip', 'verified predicate is enforced');

$d = $r->decide({ to => 'support@example.net', from => 'a@b', verified => 1 });
isnt($d->{route}, undef, 'glob matches support@ any domain');

$d = $r->decide({ to => 'nobody@example.net', from => 'a@b' });
is($d->{matched}, 0, 'no match falls through');
is((keys %{ $d->{actions}[0] })[0], 'reject', 'default action is rejection');

# time windows
my $now = time;
my @t = localtime($now);
my $at = sub {
    my ($h, $m) = @_;
    return $now - ($t[2] * 3600 + $t[3] * 60 + $t[4]) + $h * 3600 + $m * 60;
};
my $timed = Cantus::Router->new(doc => {
    version => 1, routes => [ {
        name => 'office', when => { time => '09:00-17:00' }, then => [ { answer => {} } ],
    } ],
});
is($timed->decide({ to => 'x@y', from => 'a@b', now => $at->(12, 0) })->{route},
   'office', 'inside the time window');
is($timed->decide({ to => 'x@y', from => 'a@b', now => $at->(20, 0) })->{matched},
   0, 'outside the time window');

# document validation: errors are load-time, not runtime surprises
eval { Cantus::Router->new(doc => { version => 1, routes => [ { name => 'x', then => [ { explode => {} } ] } ] }) };
like($@, qr/unknown action 'explode'/, 'unknown action rejected at load');

eval { Cantus::Router->new(doc => { version => 1, routes => [ { name => 'x', when => { colour => 'red' }, then => [ { answer => {} } ] } ] }) };
like($@, qr/unknown predicate 'colour'/, 'unknown predicate rejected at load');

eval { Cantus::Router->new(doc => { version => 2, routes => [] }) };
like($@, qr/version must be 1/, 'wrong version rejected');

# JSON loading and offline equality
my $json = JSON::PP->new->encode($doc);
my $from_json = Cantus::Router->new(doc => $json);
my $live = $r->decide({ to => 'support@example.net', from => 'x@y', now => $at->(12, 0) });
my $dry  = $from_json->decide({ to => 'support@example.net', from => 'x@y', now => $at->(12, 0) });
is_deeply($dry, $live, 'offline evaluation equals live evaluation');

done_testing();
