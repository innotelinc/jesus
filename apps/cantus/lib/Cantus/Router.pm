package Cantus::Router;
# Routing as a schema-checked document, evaluated deterministically.
# See spec/CANTUS-1.0.md section 12.
use strict;
use warnings;
use JSON::PP ();

my %PREDICATES = map { $_ => 1 } qw(to from weekday time limit event verified);
my %ACTIONS    = map { $_ => 1 } qw(answer reject forward bridge play record pause noop);

sub new {
    my ($class, %a) = @_;
    my $self = bless {
        doc   => undef,
        name  => $a{name} // 'inline',
    }, $class;
    $self->load($a{doc}) if defined $a{doc};
    return $self;
}

sub load {
    my ($self, $doc) = @_;
    $doc = JSON::PP->new->decode($doc) if !ref $doc;
    my @errors;

    push @errors, 'version must be 1'
        unless defined $doc->{version} && $doc->{version} == 1;
    push @errors, 'routes must be an array'
        unless ref $doc->{routes} eq 'ARRAY';

    for my $i (0 .. $#{ $doc->{routes} // [] }) {
        my $r = $doc->{routes}[$i];
        my $where = "route[$i]";
        if (ref $r ne 'HASH') { push @errors, "$where is not an object"; next }
        push @errors, "$where needs a name" unless defined $r->{name};
        for my $k (sort keys %{ $r->{when} // {} }) {
            push @errors, "$where: unknown predicate '$k'" unless $PREDICATES{$k};
        }
        push @errors, "$where: 'then' must be a non-empty array"
            unless ref $r->{then} eq 'ARRAY' && @{ $r->{then} };
        for my $a (@{ $r->{then} // [] }) {
            if (ref $a ne 'HASH' || keys %$a != 1) {
                push @errors, "$where: each action is a single-key object";
                next;
            }
            my ($k) = keys %$a;
            push @errors, "$where: unknown action '$k'" unless $ACTIONS{$k};
        }
    }
    die "cantus: routing document invalid:\n  - " . join("\n  - ", @errors) . "\n"
        if @errors;

    $self->{doc} = $doc;
    return $self;
}

sub _glob_match {
    my ($pattern, $value) = @_;
    return 1 unless defined $pattern;
    return 0 unless defined $value;
    my $re = join '.*', map { quotemeta } split /\*/, lc $pattern, -1;
    return lc($value) =~ /^$re$/ ? 1 : 0;
}

sub _time_match {
    my ($range, $epoch) = @_;
    return 1 unless defined $range;
    my ($a, $b) = split /-/, $range;
    return 1 unless defined $b;
    my @t = localtime($epoch // time);
    my $now = $t[2] * 60 + $t[3];
    my ($h1, $m1) = split /:/, $a;
    my ($h2, $m2) = split /:/, $b;
    my $from = $h1 * 60 + ($m1 // 0);
    my $to   = $h2 * 60 + ($m2 // 0);
    return $now >= $from && $now < $to ? 1 : 0;
}

sub _weekday_match {
    my ($list, $epoch) = @_;
    return 1 unless defined $list;
    my @t = localtime($epoch // time);
    my @names = qw(sun mon tue wed thu fri sat);
    my $d = $names[$t[6]];
    return scalar grep { lc($_) eq $d } @$list;
}

sub matches {
    my ($self, $route, $ctx) = @_;
    my $w = $route->{when} // {};
    return 0 unless _glob_match($w->{to},   $ctx->{to});
    return 0 unless _glob_match($w->{from}, $ctx->{from});
    return 0 unless _weekday_match($w->{weekday}, $ctx->{now});
    return 0 unless _time_match($w->{time}, $ctx->{now});
    if (defined $w->{verified}) {
        my $want = $w->{verified} ? 1 : 0;
        return 0 unless ($ctx->{verified} // 0) == $want;
    }
    if (defined $w->{event}) {
        return 0 unless defined $ctx->{event} && $ctx->{event} eq $w->{event};
    }
    if (defined $w->{limit}) {
        return 0 unless ($ctx->{calls} // 0) < $w->{limit};
    }
    return 1;
}

# Returns { route => name|undef, matched => bool, actions => [...] }.
# Evaluation stops at the first matching route; nothing is executed here, which
# is what makes offline testing exact.
sub decide {
    my ($self, $ctx) = @_;
    die "cantus: no routing document loaded\n" unless $self->{doc};
    $ctx->{now} //= time;
    for my $r (@{ $self->{doc}{routes} }) {
        next unless $self->matches($r, $ctx);
        return { matched => 1, route => $r->{name}, actions => $r->{then} };
    }
    my $d = $self->{doc}{default};
    return { matched => 0, route => undef, actions => $d ? [ $d ] : [ { reject => 3 } ] };
}

sub default_doc {
    return {
        version => 1,
        default => { reject => 3 },
        routes  => [
            {
                name => 'answer-all',
                when => {},
                then => [ { answer => {} } ],
            },
        ],
    };
}

1;
