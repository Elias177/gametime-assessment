import { CheckoutPane } from './CheckoutPane';
import { usePath } from './navigate';
import { StartScreen } from './StartScreen';

/** `/checkout/:id` is the desktop pane; `/resume/:id` is the link handed to another device. */
const SESSION_ROUTE = /^\/(?:checkout|resume)\/([^/]+)$/;

export function App() {
  const path = usePath();
  const match = SESSION_ROUTE.exec(path);

  return <main>{match ? <CheckoutPane key={match[1]} sessionId={decodeURIComponent(match[1]!)} /> : <StartScreen />}</main>;
}
