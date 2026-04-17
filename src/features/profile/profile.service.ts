import type { Profile, UpdateProfileInput } from './profile.types.js'
import * as profileRepo from './profile.repository.js'

export async function getOrCreateProfile(userId: string, email: string | null): Promise<Profile> {
  return profileRepo.ensureProfile(userId, email)
}

export async function updateProfile(userId: string, input: UpdateProfileInput): Promise<Profile> {
  await profileRepo.ensureProfile(userId, null)
  return profileRepo.updateProfile(userId, input)
}
