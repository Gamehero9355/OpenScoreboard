/**
 * The two World Cup groups, as the format actually splits them.
 *
 * There is no group assignment to make: a team plays in the group of the playing
 * field it was registered on, so Group A is Field 1's roster and Group B is Field
 * 2's. This panel only *shows* that, on the rules step, before anything is
 * created -- it is a mirror of the roster the host typed one step earlier, not a
 * second place where the split is decided.
 *
 * That is the whole reason it is read-only. A control here would be a second
 * answer to a question the home field has already answered, and the two could
 * disagree -- silently, at the first fixture, with a team listed in one group and
 * playing in the other.
 *
 * The A1..An labels are *positions*, not seeds: A1 is whoever finishes first in
 * Group A, which is what lets the final phase be written as "A1 vs B2" and still
 * be right after a result is corrected.
 */
import type { MessageKey } from '../lib/i18n';
import { useI18n } from '../lib/useI18n';

export interface WorldCupGroupView {
  letter: 'A' | 'B';
  /** The playing field the group plays on: Field 1 for A, Field 2 for B. */
  fieldName: string;
  /** Team names, in the order they were registered on that field. */
  teams: string[];
}

export interface WorldCupGroupsProps {
  groups: WorldCupGroupView[];
}

export function WorldCupGroups({ groups }: WorldCupGroupsProps) {
  const { t } = useI18n();
  return (
    <div className="wc-groups">
      <div className="wc-groups__cols">
        {groups.map((group) => (
          <section key={group.letter} className="wc-groups__col" aria-label={groupName(group.letter, t)}>
            <header className="wc-groups__col-head">
              <span className="wc-groups__col-title">{groupName(group.letter, t)}</span>
              <span className="tiny dim">
                {group.fieldName} · {t('setup.roundRobinSuffix')}
              </span>
            </header>
            {group.teams.length === 0 ? (
              <p className="hint">{t('radball.wcNoTeams', { field: group.fieldName })}</p>
            ) : (
              <ul className="wc-groups__list">
                {group.teams.map((name, slot) => (
                  <li key={`${slot}-${name}`} className="wc-groups__row">
                    <span
                      className="wc-groups__pos tnum"
                      title={t('radball.wcPosition', { label: `${group.letter}${slot + 1}` })}
                    >
                      {group.letter}
                      {slot + 1}
                    </span>
                    <span className="wc-groups__name grow">{name}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      <p className="hint">
        {t('radball.wcExplainer', {
          a: groups[0]?.teams.length || 1,
          b: groups[1]?.teams.length || 1,
        })}
      </p>
    </div>
  );
}

/** "Group A" / "Group B", in the host's own language. */
function groupName(letter: 'A' | 'B', t: (key: MessageKey) => string): string {
  return letter === 'B' ? t('radball.groupB') : t('radball.groupA');
}
