export interface Profile {
  id: string
  email: string | null
  fullName: string | null
  stripeCustomerId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface UpdateProfileInput {
  fullName?: string | null
}
