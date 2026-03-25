import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { RunQuestion } from './questions.types.js'

interface QuestionRow {
  id: string
  run_id: string
  step_id: string | null
  question: string
  answer: string | null
  answered_at: string | null
  created_at: string
}

function mapToQuestion(row: QuestionRow): RunQuestion {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    question: row.question,
    answer: row.answer,
    answeredAt: row.answered_at ? new Date(row.answered_at) : null,
    createdAt: new Date(row.created_at),
  }
}

export async function findQuestionsByRunId(runId: string): Promise<RunQuestion[]> {
  const { data, error } = await supabase
    .from('run_questions')
    .select('*')
    .eq('run_id', runId)
    .order('created_at', { ascending: true })
  if (error) throw new DatabaseError(error.message)
  return (data as QuestionRow[]).map(mapToQuestion)
}

export async function findQuestionById(id: string): Promise<RunQuestion | null> {
  const { data, error } = await supabase.from('run_questions').select('*').eq('id', id).single()
  if (error && error.code === 'PGRST116') return null
  if (error) throw new DatabaseError(error.message)
  return data ? mapToQuestion(data as QuestionRow) : null
}

export async function createQuestion(input: {
  runId: string
  stepId?: string | null
  question: string
}): Promise<RunQuestion> {
  const { data, error } = await supabase
    .from('run_questions')
    .insert({
      run_id: input.runId,
      step_id: input.stepId || null,
      question: input.question,
    })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToQuestion(data as QuestionRow)
}

export async function answerQuestion(id: string, answer: string): Promise<RunQuestion> {
  const { data, error } = await supabase
    .from('run_questions')
    .update({ answer, answered_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToQuestion(data as QuestionRow)
}
