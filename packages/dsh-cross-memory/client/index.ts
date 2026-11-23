/**
 * `dsh-cross-memory` browser half.
 *
 * Shipped as the package's `./client` bundle: the DSH client module system
 * loads it as a `window.__ModuleLoader__.load({ id, factory })` script, calls
 * `factory(require)`, and mounts the exported plugin (`apply` + `inject`) into
 * the browser Cordis tree.
 *
 * It contributes three surfaces, fed by the same pieces:
 *
 *   - the **Memories page** (`settings.section`): it lists, searches, adds, and
 *     deletes memories through the Remote namespace the host registers, and it
 *     embeds the tunables card at its foot;
 *   - the **configuration card** (`plugins.bundle.config`, keyed by the package
 *     name), since 2026-09-25: the same card, rendered on this bundle's own page
 *     on the Plugins page, between the description and the rows — where the
 *     official plugins put their configuration. The card is reused verbatim;
 *     only its registration is new.
 *   - the **confirmation card body** (`ctx.actionCards.register`, since 0.2.9):
 *     the buttons of the `resolve_memory_proposal` card the Host kind offers in
 *     an answer. Without this body the shell's frame would offer only Not now.
 *
 * Both edit the entry's own live form, so the two editors can never disagree.
 * The page keeps its menu: it is a feature surface, not a configuration menu.
 *
 * Written as plain CJS with `createElement` instead of JSX so the package needs
 * no bundler: the bundle only requires modules the browser already provides
 * (`react`) and reaches every service through Cordis. The parts live in
 * `client/parts/`; `scripts/build-client.mjs` concatenates them in order,
 * defines `PACKAGE` (the package name, from `package.json`) and injects the
 * host's own wire table.
 */

/** Copy for the active locale. */
function sectionCopy(ctx) {
  const locale = ctx.get('locale')
  const active = typeof locale?.getLocale === 'function' ? locale.getLocale().active : undefined
  const isZh = typeof active === 'string' && active.length > 0
    ? active.startsWith('zh')
    : typeof navigator !== 'undefined' && String(navigator.language ?? '').startsWith('zh')
  return SECTION_COPY[isZh ? 'zh' : 'en']
}

/**
 * Create the browser-half plugin from the bundle's `require`.
 * @param require - the module system's synchronous require.
 * @returns the plugin's `apply` and `inject`.
 */
function createPlugin(require) {
  const React = require('react')
  const Card = createMemoriesCard(React)
  const Section = createMemoriesSection(React, Card)
  const ProposalCard = createProposalCardBody(React)

  const apply = async (ctx) => {
    ensureStyles()
    // The consolidation confirmation card: the shell's action-card frame finds
    // this body by the action the Host kind registered. Both services are
    // optional — an older shell keeps the memories page and simply offers no
    // card body (its frame would show Not now alone), which is the same
    // degradation the page already documents.
    if (typeof ctx.inject === 'function') {
      ctx.inject(['actionCards', 'locale'], (child) => {
        child.effect(() => child.locale.register(PROPOSAL_CARD_LOCALE, PROPOSAL_COPY), 'dsh-cross-memory.proposalLocale')
        child.effect(() => child.actionCards.register({
          action: PROPOSAL_CARD_ACTION,
          locale: PROPOSAL_CARD_LOCALE,
          Body: ProposalCard,
        }), 'dsh-cross-memory.proposalCard')
      })
    }
    // The form is shared with every other editor of this entry and owned by the
    // settings provider, so this half only subscribes to it (inside
    // `useSnapshot`) and never disposes it.
    const scope = ctx.configForms.get(NS)
    const useSnapshot = (select) => {
      const [value, setValue] = React.useState(() => select(scope.getSnapshot()))
      React.useEffect(() => scope.subscribe(() => setValue(select(scope.getSnapshot()))), [scope])
      return value
    }

    // The page is useless without the host API, but the tunables card is not, so
    // a missing gateway degrades this surface instead of failing the plugin.
    let api
    try {
      api = await mountMemoriesRemote(ctx)
    } catch (failure) {
      ctx.logger?.warn?.('dsh-cross-memory: remote mount failed: %o', failure)
    }
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'memories',
      order: 25,
      label: () => sectionCopy(ctx).label,
      inject: () => ({ api, scope, useSnapshot, copy: sectionCopy(ctx) }),
    }, Section))
    // The tunables card, mounted a second time on the Plugins page: slot
    // `plugins.bundle.config`, key = the package name, rendered on this bundle's
    // own page between its description and its rows. That slot hands **no**
    // `form` in (unlike `plugins.row.config`), so the registration's inject face
    // supplies the same shared props the page's own 配置 tab supplies — the same
    // `scope` and `useSnapshot`, so both editors read one form and write through
    // one path. The copy is resolved inside the face, like the page's, so a
    // locale switch is picked up. `PACKAGE` is defined by
    // `scripts/build-client.mjs`, which also uses it as the bundle id.
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: PACKAGE,
      inject: () => {
        const copy = sectionCopy(ctx)
        return { scope, useSnapshot, title: copy.tunables, intro: false, lang: copy.lang }
      },
    }, Card))
  }

  return { apply, inject: ['slots', 'configForms'] }
}
