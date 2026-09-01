package server

import (
	"testing"
	"time"
)

func TestShareTokenRoundtrip(t *testing.T) {
	a := newAuthn(nil, "app123")
	claims := shareClaims{
		Room: "r1", UserID: "u1:tab", Username: "pedro (sharing)",
		Exp: time.Now().Add(time.Minute).Unix(),
	}
	tok := a.mintShareToken(claims)

	got, err := a.verifyShareToken(tok)
	if err != nil {
		t.Fatal(err)
	}
	if got != claims {
		t.Fatalf("claims mismatch: %+v != %+v", got, claims)
	}
}

func TestShareTokenTampered(t *testing.T) {
	a := newAuthn(nil, "app123")
	tok := a.mintShareToken(shareClaims{Room: "r1", Exp: time.Now().Add(time.Minute).Unix()})
	if _, err := a.verifyShareToken(tok + "x"); err == nil {
		t.Fatal("tampered token accepted")
	}
	if _, err := newAuthn(nil, "app123").verifyShareToken(tok); err == nil {
		t.Fatal("token from another key accepted")
	}
}

func TestShareTokenExpired(t *testing.T) {
	a := newAuthn(nil, "app123")
	tok := a.mintShareToken(shareClaims{Room: "r1", Exp: time.Now().Add(-time.Second).Unix()})
	if _, err := a.verifyShareToken(tok); err == nil {
		t.Fatal("expired token accepted")
	}
}
