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
      <section className={styles.intro} aria-labelledby="game-title">
        <div className={styles.eyebrow}>Physics-first tabletop football</div>
        <h1 id="game-title">
          Flick<span>XI</span>
        </h1>
        <p>
          Pull back. Read the angle. Chain the pass. A mobile-first football
          duel where every touch follows the physics.
        </p>
        <div className={styles.featureList} aria-label="Game features">
          <span>6 × 6</span>
          <span>Unlimited pass chains</span>
          <span>First to 3</span>
        </div>
      </section>

      <FlickFootball initialRoomCode={roomCode} />
    </main>
  );
}
