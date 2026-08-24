import FlickFootball from "@/components/FlickFootball";
import styles from "./page.module.css";

type HomeProps = {
  searchParams: Promise<{ room?: string | string[] }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const roomCode = Array.isArray(params.room) ? params.room[0] : params.room;
  return (
    <main className={styles.page}>
      <FlickFootball initialRoomCode={roomCode} />
    </main>
  );
}
