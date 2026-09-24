// File d'attente du service vidéo : 2 traitements à la fois, les autres attendent.
import * as db from '../db.js'
import { fail, processSop } from './index.js'

const MAX_PARALLEL = 2
const queue: string[] = []
let running = 0

export function enqueue(sopId: string): void {
  if (!queue.includes(sopId)) queue.push(sopId)
  void drain()
}

async function drain(): Promise<void> {
  while (running < MAX_PARALLEL && queue.length > 0) {
    const id = queue.shift()!
    running++
    processSop(id)
      .catch((err) => console.error(`[pipeline] ${id}`, err))
      .finally(() => {
        running--
        void drain()
      })
  }
}

/** Au démarrage du service : les traitements coupés par un redémarrage sont passés en échec et remboursés. */
export async function recoverInterrupted(): Promise<void> {
  for (const sop of await db.listProcessingSops()) {
    await fail(sop, 'Processing was interrupted. Your credits were refunded, please try again.')
  }
}
