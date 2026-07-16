import { Controller } from '../controller';
import { makeFakeContext } from '../test/helpers/extensionContext';

/** Builds a Controller against a fake ExtensionContext and a fake UiSink that just
 *  records posted messages, so tests can assert on message sequences without a real webview. */
export async function makeController() {
  const context = await makeFakeContext();
  const controller = new Controller(context as any);
  const posted: Record<string, unknown>[] = [];
  controller.attachUi({ post: (m) => posted.push(m) });
  return { controller, posted, context };
}
