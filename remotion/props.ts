// Données passées aux compositions Remotion (partagées avec le serveur, sans dépendance).

export const VIDEO_FPS = 30

export interface Brand {
  productName: string
  /** Couleur principale du produit (hex). */
  accent: string
  /** Couleur secondaire (hex). */
  accent2: string
  /** Fond des scènes (hex). */
  background: string
  /** Couleur du texte sur ce fond (hex). */
  text: string
}

export interface Shot {
  /** Capture d'écran du produit (data URL JPEG). */
  src: string
  width: number
  height: number
  /** Ce qu'on y voit. */
  description: string
}

export interface SceneProps {
  /** Code JS compilé définissant `function Scene(...)`, ou null → scène de secours. */
  code: string | null
  durationInFrames: number
  /** Captures utilisables par la scène. */
  shots: Shot[]
  /** Texte de secours (et titre de la scène de secours). */
  headline: string
}

export interface CaptionWord {
  text: string
  startMs: number
  endMs: number
}

export type MarketingProps = {
  width: number
  height: number
  brand: Brand
  scenes: SceneProps[]
  captions: CaptionWord[]
}

export type ScenePreviewProps = {
  width: number
  height: number
  brand: Brand
  scene: SceneProps
}
