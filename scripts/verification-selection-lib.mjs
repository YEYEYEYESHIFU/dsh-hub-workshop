function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function verificationInput(record) {
  return canonical({ id: record?.id, submission: record?.submission })
}

export function selectVerificationReleaseIds({ currentRecords, previousRecords = [], globalChanged = false }) {
  const previous = new Map(previousRecords.map((record) => [record.id, verificationInput(record)]))
  return currentRecords
    .filter((record) => globalChanged || previous.get(record.id) !== verificationInput(record))
    .map((record) => record.id)
    .sort()
}
