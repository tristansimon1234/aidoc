/**
 * Mode local : les fichiers ont des adresses relatives (« /api/local-files/… »), complétées avec
 * l'adresse du serveur qui répond. Répare aussi les anciennes adresses « http://localhost:… ».
 * Une adresse déjà complète vers un autre domaine n'est pas touchée.
 */
export function withAbsoluteUrls(text: string, base: string): string {
  return text.replace(
    /(^|[("'\s])(?:https?:\/\/localhost:\d+)?\/api\/local-files\//g,
    `$1${base}/api/local-files/`,
  )
}
