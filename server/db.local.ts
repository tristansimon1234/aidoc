// Mode local (sans Supabase) : pour tester sur son poste sans compte ni connexion.
// Base = un fichier JSON, fichiers = un dossier, un seul utilisateur « local ».
// Tourne sur son poste ou sur Railway (sans volume, les données sont perdues à chaque déploiement).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Account, Sop, SopKind, SopPatch, Voice } from './db.types.js'

export const LOCAL_DIR = join(process.cwd(), '.local-data')
export const LOCAL_FILES_DIR = join(LOCAL_DIR, 'files')
const DB_FILE = join(LOCAL_DIR, 'db.json')

export const LOCAL_TOKEN = 'local'
const LOCAL_USER_ID = '00000000-0000-4000-8000-000000000001'
const LOCAL_CREDITS = 100

interface LocalDb {
  accounts: Record<string, Account>
  sops: Sop[]
  refs: string[]
}

function load(): LocalDb {
  if (!existsSync(DB_FILE)) return { accounts: {}, sops: [], refs: [] }
  const db = JSON.parse(readFileSync(DB_FILE, 'utf8')) as LocalDb
  // Créations enregistrées avant l'ajout de la régénération.
  db.sops = db.sops.map((s) => ({ ...s, feedback: s.feedback ?? null, revision: s.revision ?? 0 }))
  return db
}

function save(db: LocalDb): void {
  mkdirSync(LOCAL_DIR, { recursive: true })
  writeFileSync(`${DB_FILE}.tmp`, JSON.stringify(db, null, 2))
  renameSync(`${DB_FILE}.tmp`, DB_FILE)
}

function account(db: LocalDb, userId: string): Account {
  db.accounts[userId] ??= { credits: LOCAL_CREDITS, stripeCustomerId: null }
  return db.accounts[userId]
}

// ── Auth ─────────────────────────────────────────────────────

export async function userIdFromToken(token: string): Promise<string | null> {
  return token === LOCAL_TOKEN ? LOCAL_USER_ID : null
}

export async function testUserId(): Promise<string> {
  return LOCAL_USER_ID
}

export async function userEmail(): Promise<string | null> {
  return 'local@doclee.dev'
}

// ── Comptes & crédits ────────────────────────────────────────

export async function getAccount(userId: string): Promise<Account> {
  const db = load()
  const acc = { ...account(db, userId) }
  save(db)
  return acc
}

export async function setStripeCustomerId(userId: string, customerId: string): Promise<void> {
  const db = load()
  account(db, userId).stripeCustomerId = customerId
  save(db)
}

export async function findUserIdByStripeCustomer(customerId: string): Promise<string | null> {
  const db = load()
  return (
    Object.keys(db.accounts).find((id) => db.accounts[id]?.stripeCustomerId === customerId) ?? null
  )
}

export async function applyCredits(
  userId: string,
  delta: number,
  _reason: string,
  ref?: string,
): Promise<boolean> {
  const db = load()
  if (ref && db.refs.includes(ref)) return false
  const acc = account(db, userId)
  if (acc.credits + delta < 0) return false
  acc.credits += delta
  if (ref) db.refs.push(ref)
  save(db)
  return true
}

// ── SOPs ─────────────────────────────────────────────────────

export async function createSop(input: {
  id: string
  userId: string
  title: string
  language: string
  voice: Voice
  tone: string
  kind: SopKind
  brief: string | null
  targetSeconds: number
  music: boolean
  sourcePath: string
}): Promise<Sop> {
  const now = new Date().toISOString()
  const sop: Sop = {
    ...input,
    status: 'uploading',
    progress: null,
    error: null,
    creditsUsed: 0,
    feedback: null,
    revision: 0,
    durationSeconds: null,
    markdown: null,
    videoPath: null,
    createdAt: now,
    updatedAt: now,
  }
  const db = load()
  db.sops.push(sop)
  save(db)
  return sop
}

export async function listSops(userId: string): Promise<Sop[]> {
  return load()
    .sops.filter((s) => s.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getSop(id: string): Promise<Sop | null> {
  return load().sops.find((s) => s.id === id) ?? null
}

export async function updateSop(id: string, patch: SopPatch): Promise<void> {
  const db = load()
  const sop = db.sops.find((s) => s.id === id)
  if (!sop) return
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  Object.assign(sop, defined, { updatedAt: new Date().toISOString() })
  save(db)
}

export async function deleteSop(id: string): Promise<void> {
  const db = load()
  db.sops = db.sops.filter((s) => s.id !== id)
  save(db)
}

export async function listProcessingSops(): Promise<Sop[]> {
  return load().sops.filter((s) => s.status === 'processing')
}

// ── Stockage (dossier .local-data/files, servi par l'API sur /api/local-files) ──

/** Chemin disque d'un fichier ; refuse tout chemin qui sortirait du dossier. */
export function localFilePath(path: string): string {
  if (path.split('/').some((part) => part === '..' || part === ''))
    throw new Error('Chemin invalide')
  return join(LOCAL_FILES_DIR, path)
}

export async function createUploadUrl(path: string): Promise<{ signedUrl: string; token: string }> {
  return { signedUrl: `/api/local-files/${path}`, token: '' }
}

export async function fileExists(path: string): Promise<boolean> {
  return existsSync(localFilePath(path))
}

export async function uploadFile(path: string, body: Buffer): Promise<void> {
  const file = localFilePath(path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, body)
}

/** Contenu d'un fichier, ou null s'il n'existe pas. */
export async function downloadFile(path: string): Promise<Buffer | null> {
  return existsSync(localFilePath(path)) ? readFile(localFilePath(path)) : null
}

/** Ce que ffmpeg doit lire pour ce fichier : directement le disque. */
export function sourceForFfmpeg(path: string): string {
  return localFilePath(path)
}

/**
 * Adresse relative : l'API la complète avec l'adresse du serveur qui répond (voir withAbsoluteUrls
 * dans routes.ts), donc elle marche en local, sur Railway ou derrière n'importe quel domaine.
 */
export function publicUrl(path: string): string {
  return `/api/local-files/${path}`
}

export async function deleteFile(path: string): Promise<void> {
  await rm(localFilePath(path), { force: true })
}

export async function deleteFolder(prefix: string): Promise<void> {
  await rm(localFilePath(prefix), { recursive: true, force: true })
}
