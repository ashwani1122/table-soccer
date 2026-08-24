import FlickFootball from "@/components/FlickFootball";
import styles from "./page.module.css";

type HomeProps = {
  searchParams: Promise<{ room?: string | string[] }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const roomCode = Array.isArray(params.room) ? params.room[0] : params.room;
  const authEnabled = Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
  );
  return (
    <main className={styles.page}>
      <FlickFootball initialRoomCode={roomCode} authEnabled={authEnabled} />
    </main>
  );
}
