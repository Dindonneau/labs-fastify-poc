export const logErrorMessage = (error: unknown) =>
  console.error(error instanceof Error ? error.message : error)
