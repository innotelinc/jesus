package Cantus::Identity;
# Key-bound endpoint identity and message integrity.
# Normative profile is Ed25519 (spec 10.2); this reference stack ships the
# sig-hmac-sha256 test profile, which is loopback-only by rule.
use strict;
use warnings;
use Digest::SHA qw(sha256 hmac_sha256);
use Cantus::Wire ();

sub new {
    my ($class, %a) = @_;
    my $name = $a{name} // die "Cantus::Identity needs a name\n";
    my $secret = $a{secret} // sha256("cantus/1-test-secret:$name");
    return bless { name => $name, secret => $secret }, $class;
}

sub name { $_[0]{name} }

# 32-octet public key.  The test profile derives it from the shared secret so a
# deployment can pin keys without a PKI; the normative profile uses Ed25519.
sub public_key { $_[0]{pub} //= sha256("cantus/1-pub:" . $_[0]{secret}) }

sub sign {
    my ($self, $type, $fields) = @_;
    return hmac_sha256(Cantus::Wire::signing_input($type, $fields), $self->{secret});
}

sub verify {
    my ($self, $type, $fields, $sig, $peer_secret) = @_;
    return 0 unless defined $sig && length $sig;
    my $want = hmac_sha256(Cantus::Wire::signing_input($type, $fields),
                           $peer_secret // die "no peer secret\n");
    return $want eq $sig ? 1 : 0;
}

sub short_key {
    my ($self) = @_;
    return substr(unpack('H*', $self->public_key), 0, 16);
}

1;
