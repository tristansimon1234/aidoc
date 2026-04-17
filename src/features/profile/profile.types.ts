export interface Profile {
  id: string
  email: string | null
  fullName: string | null
  stripeCustomerId: string | null
  isAdmin: boolean
  createdAt: Date
  updatedAt: Date
}

export interface UpdateProfileInput {
  fullName?: string | null
}
