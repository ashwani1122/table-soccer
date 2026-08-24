"use client";

import { SignInButton, UserButton, useUser } from "@clerk/nextjs";
import { useEffect } from "react";
import styles from "./FlickFootball.module.css";

export default function AuthIdentity({ onIdentity }: { onIdentity: (name: string) => void }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const displayName = user?.fullName || user?.firstName || "Player";

  useEffect(() => {
    if (isSignedIn && displayName) onIdentity(displayName.slice(0, 18));
  }, [displayName, isSignedIn, onIdentity]);

  if (!isLoaded) return <div className={styles.authSkeleton} aria-label="Loading account" />;

  if (isSignedIn) {
    return (
      <div className={styles.signedIdentity}>
        <UserButton />
        <div>
          <strong>{displayName}</strong>
          <span>GOOGLE ACCOUNT CONNECTED</span>
        </div>
      </div>
    );
  }

  return (
    <SignInButton mode="modal">
      <button className={styles.googleButton} type="button">
        <b aria-hidden="true">G</b>
        <span>CONTINUE WITH GOOGLE</span>
        <small>OPTIONAL</small>
      </button>
    </SignInButton>
  );
}
