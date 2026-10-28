#!/usr/bin/perl
# Rewrite a `git fast-export` stream so every path gains a directory prefix.
# Reads a fast-export stream on STDIN, writes a fast-import stream on STDOUT.
#
# usage: prefix.pl <prefix> [<branch-suffix>] < export > import
#   prefix        e.g. apps/cantus
#   branch-suffix e.g. cantus  -> refs/heads/<branch> becomes refs/heads/import/cantus
#
# Paths inside `data` blocks are never touched: data is copied by byte count,
# so a commit message that happens to start with "M " cannot corrupt the stream.
use strict;
use warnings;

my $prefix = shift // die "usage: prefix.pl <prefix> [branch-suffix]\n";
my $suffix = shift;
$prefix =~ s{/+$}{};

binmode STDIN;
binmode STDOUT;

my $buf = '';
my $eof = 0;

sub fill {
    my ($want) = @_;
    while (length($buf) < $want && !$eof) {
        my $got = sysread(STDIN, my $chunk, 65536);
        die "read failed: $!\n" unless defined $got;
        if ($got == 0) { $eof = 1; last }
        $buf .= $chunk;
    }
    return length($buf);
}

sub getline {
    my $i = index($buf, "\n");
    if ($i < 0) {
        return undef if $eof;
        fill(length($buf) + 1);
        $i = index($buf, "\n");
        return undef if $i < 0;
    }
    my $line = substr($buf, 0, $i);
    substr($buf, 0, $i + 1, '');
    return $line;
}

# Windows cannot represent < > : " | ? * or control characters in a filename,
# and one project's history names session directories like
# "03-03-09:09-add-console-log". Map those bytes to '-' so the tree checks out
# on NTFS; every other path is left exactly as it was.
sub sanitize {
    my ($path) = @_;
    $path =~ s/[<>:"|?*\x00-\x1f]/-/g;
    return $path;
}

# fast-export C-quotes paths that contain spaces or other awkward bytes.
sub prepend {
    my ($path) = @_;
    # A quoted path keeps its quotes: sanitising the body must not eat the
    # closing quote, or fast-import sees an unterminated string.
    if ($path =~ /^"(.*)"$/s) {
        return '"' . $prefix . '/' . sanitize($1) . '"';
    }
    return $prefix . '/' . sanitize($path);
}

while (defined(my $line = getline())) {
    # Blob/message payload: copy exactly <n> bytes, never interpret them.
    if ($line =~ /^data (\d+)$/) {
        my $n = $1;
        fill($n);
        die "short data block: wanted $n bytes, have " . length($buf) . "\n" if length($buf) < $n;
        print "data $n\n", substr($buf, 0, $n, '');   # consume the bytes
        next;
    }

    # File operations carry the path at the end: "M <mode> <dataref> <path>", "D <path>".
    # Rename records (R/C) only appear when fast-export is asked to detect them,
    # which we do not do.
    my $rewritten;
    if ($line =~ /^M (\S+) (\S+) (.+)$/s) {
        $rewritten = "M $1 $2 " . prepend($3);
    } elsif ($line =~ /^D (.+)$/s) {
        $rewritten = 'D ' . prepend($1);
    }
    if (defined $rewritten) {
        print "$rewritten\n";
        next;
    }

    # Keep each import on its own branch so no two projects fight over main.
    if (defined $suffix && $line =~ m{^commit refs/heads/\S+$}) {
        print "commit refs/heads/import/$suffix\n";
        next;
    }

    print "$line\n";
}

die "stream ended with unread bytes\n" if length($buf);
