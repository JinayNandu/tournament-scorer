/* The shared backend, or nothing.
 *
 * Empty, the app behaves exactly as it always has: the Artifact db when it
 * is published there, the device on its own anywhere else. Filled in, this
 * becomes THE backend in both places, so that everyone - the organiser in
 * the artifact, eleven scorers on a public link, anyone watching - is
 * looking at one tournament rather than several.
 *
 * To fill it in:
 *
 *   1. console.firebase.google.com, Add project. Analytics is not needed.
 *   2. Build > Firestore Database > Create database. Start in PRODUCTION
 *      mode and pick a region near the tournament.
 *   3. Build > Authentication > Get started > Anonymous > Enable. This is
 *      the one step that is easy to skip and impossible to diagnose
 *      afterwards: without it nobody has a uid, the rules cannot tell one
 *      phone from another, and every attempt to score is refused with no
 *      clue as to why.
 *   4. Rules > paste tools/firestore.rules > Publish. Read them first:
 *      they let anyone with the link WATCH, and give scoring only to
 *      whoever has been given a code.
 *   5. Project settings > General > Your apps > Web. Register the app and
 *      copy the config object it shows into the one below.
 *   6. Open the app. It will ask you to set an organiser key, which is
 *      what lets you create tournaments. Do that before the link goes
 *      anywhere - see tools/firestore.rules for why.
 *
 * None of this is a secret. A Firebase web config identifies the project;
 * it does not authorise anything, which is why Google prints it into every
 * web app it generates. What decides who may read and write is the rules
 * file, and it is worth reading on its own account.
 */
window.TS_FIREBASE = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: ''
};
