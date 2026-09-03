/** Turns a native shell document-load failure code into text the hosted shell can show. */
export function mobileWebShellLoadFailureWarning(reason: string | undefined): string {
  if (reason === 'mobile_web_generation_invalid') {
    return 'This desktop’s cached workspace interface failed verification and was not displayed.'
  }
  if (reason && reason !== 'mobile_web_document_unavailable') {
    return `The workspace interface could not be displayed (${reason}).`
  }
  return 'The workspace interface could not be displayed.'
}
