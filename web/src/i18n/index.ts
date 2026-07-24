import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en/translation.json'

// English is the only shipped locale today. Adding another language means
// dropping a new locales/<lng>/translation.json next to this one and listing
// it in `resources` below — no other code changes needed.
export const supportedLngs = ['en']

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs,
  interpolation: {
    escapeValue: false, // React already escapes rendered content
  },
})

export default i18n
