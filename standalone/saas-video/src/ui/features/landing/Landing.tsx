import { Link } from 'react-router-dom'
import styles from './Landing.module.css'

/**
 * Public landing page. Intentionally bare-bones for now — copy + a couple
 * of feature blurbs + a CTA. The bar to beat is "would a SaaS founder
 * scrolling Twitter click through and try this?" — we'll iterate copy
 * once we see who's converting.
 */
export function Landing(): React.ReactElement {
  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <span className={styles.logo}>SaaS Video</span>
        <div className={styles.navActions}>
          <Link to="/login" className={styles.navLink}>Log in</Link>
          <Link to="/signup" className={styles.cta}>Try free</Link>
        </div>
      </header>

      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>
          AI product videos<br />in 3 minutes.
        </h1>
        <p className={styles.heroSubtitle}>
          Write a brief. We generate a polished 45-second SaaS product video — animated UI mocks,
          voice-over, and music. No recording, no editor, no agency.
        </p>
        <div className={styles.heroActions}>
          <Link to="/signup" className={styles.heroPrimary}>Generate one free</Link>
          <Link to="/login" className={styles.heroSecondary}>Sign in</Link>
        </div>
        <p className={styles.heroFootnote}>
          1 free credit on signup. No credit card. Pay per video after that.
        </p>
      </section>

      <section className={styles.features}>
        <div className={styles.featureCard}>
          <div className={styles.featureNumber}>1</div>
          <h3 className={styles.featureTitle}>Write a brief</h3>
          <p className={styles.featureText}>
            Tell us what you're launching, who it's for, what angle to take. One paragraph is enough.
          </p>
        </div>
        <div className={styles.featureCard}>
          <div className={styles.featureNumber}>2</div>
          <h3 className={styles.featureTitle}>We design every frame</h3>
          <p className={styles.featureText}>
            Animated UI mocks that look like your product, narrated by a voice that matches your brand,
            scored with music that fits the tone.
          </p>
        </div>
        <div className={styles.featureCard}>
          <div className={styles.featureNumber}>3</div>
          <h3 className={styles.featureTitle}>Iterate by chat</h3>
          <p className={styles.featureText}>
            "Shorten scene 2, switch the accent to blue, change the hook." We re-render in seconds.
          </p>
        </div>
      </section>

      <footer className={styles.footer}>
        <span>SaaS Video</span>
        <Link to="/login" className={styles.navLink}>Log in</Link>
      </footer>
    </div>
  )
}
