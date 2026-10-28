package Cantus::Pump;
# The event-loop pump contract, shared by Cantus::Node, Cantus::Relay and
# Cantus::NatSim so every component answers the same question the same way:
#
#   pump()            serve one default slice (DEFAULT_SLICE), then return
#   pump(0)           DRAIN: serve what is already queued, then return at once
#   pump($seconds>0)  serve for at most $seconds, then return
#
# The zero case is not "no work" and not "wait forever": it is "drain and
# return".  It exists because whoever owns the waiting must not have the waiting
# done twice.  Asking N sockets to each block for their own sub-millisecond
# budget costs a full scheduler tick per socket where select() rounds timeouts
# up (Windows rounds to its ~15 ms timer), so a loop that pumps five components
# that way runs at ~20 Hz and starves whichever one carries the most traffic —
# in practice the relay, which then delivers control messages a second late.
#
# A caller that owns the waiting therefore pumps every component with 0 and
# sleeps once.  See spec/CANTUS-1.0.md §15.
use strict;
use warnings;
use Time::HiRes qw(time);

use constant {
    DRAIN         => 0,        # the budget that means "drain and return"
    DEFAULT_SLICE => 0.020,    # pump() with no argument
    MAX_WAIT      => 0.010,    # longest single can_read() inside a timed pump
};

# Is this budget the drain budget?  Undefined is not: it means "default slice".
sub is_drain {
    my ($seconds) = @_;
    return defined $seconds && $seconds <= DRAIN ? 1 : 0;
}

# The budget a call actually has.
sub budget {
    my ($seconds) = @_;
    return defined $seconds ? $seconds : DEFAULT_SLICE;
}

# Absolute deadline for a timed pump.  For a drain it is now, but callers test
# is_drain first because a drain never expires: it ends when the sockets are
# empty, not when a clock says so.
sub deadline {
    my ($seconds) = @_;
    return time + budget($seconds);
}

# How long one can_read() may block.  A drain never blocks.
sub wait_for {
    my ($seconds, $left) = @_;
    return 0 if is_drain($seconds);
    $left = budget($seconds) unless defined $left;
    return $left > MAX_WAIT ? MAX_WAIT : ($left > 0 ? $left : 0);
}

# Has a timed pump used up its budget?  Always false for a drain.
sub expired {
    my ($seconds, $until) = @_;
    return 0 if is_drain($seconds);
    return time >= $until ? 1 : 0;
}

# Is this pump finished?  A drain is finished when nothing was ready; a timed
# pump is finished only when its budget is gone (checked with expired()).
sub finished {
    my ($seconds, $ready) = @_;
    return is_drain($seconds) && !@$ready ? 1 : 0;
}

1;
