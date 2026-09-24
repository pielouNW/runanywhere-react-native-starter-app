/**
 * FindingsKit - shared building blocks for the findings repro screens.
 *
 * Every repro screen drives the real RunAnywhere SDK loaded in this app and
 * shows what it gets back. NobodyWho is not linked into this app, so its side
 * of each comparison is the result recorded in findings/comparison.md, shown
 * as a labelled reference, never as a live run.
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { AppColors } from '../theme';

export const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

/** Pretty-print a JSON string; falls back to the raw string. */
export const formatJson = (json: string | undefined | null): string => {
  if (!json) return '(empty)';
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
};

// ─── Finding header ─────────────────────────────────────────────

interface FindingHeaderProps {
  title: string;
  claim: string;
}

export const FindingHeader: React.FC<FindingHeaderProps> = ({
  title,
  claim,
}) => (
  <View style={styles.headerContainer}>
    <Text style={styles.headerTitle}>{title}</Text>
    <Text style={styles.headerClaim}>{claim}</Text>
  </View>
);

// ─── Action button ──────────────────────────────────────────────

interface ActionButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  accentColor: string;
}

export const ActionButton: React.FC<ActionButtonProps> = ({
  label,
  onPress,
  disabled,
  busy,
  accentColor,
}) => (
  <TouchableOpacity
    style={[
      styles.buttonContainer,
      { borderColor: accentColor, backgroundColor: accentColor + '20' },
      (disabled || busy) && styles.buttonDisabledContainer,
    ]}
    onPress={onPress}
    disabled={disabled || busy}
  >
    {busy ? (
      <ActivityIndicator size="small" color={accentColor} />
    ) : (
      <Text style={[styles.buttonText, { color: accentColor }]}>{label}</Text>
    )}
  </TouchableOpacity>
);

// ─── Result card ────────────────────────────────────────────────

export type Verdict = 'pass' | 'fail' | 'info';

interface ResultCardProps {
  title: string;
  body?: string;
  verdict?: Verdict;
  /** Render body in a monospace font (JSON, grammars, raw text). */
  mono?: boolean;
}

const VERDICT_COLORS: Record<Verdict, string> = {
  pass: AppColors.accentGreen,
  fail: AppColors.error,
  info: AppColors.info,
};

const VERDICT_ICONS: Record<Verdict, string> = {
  pass: '✅',
  fail: '❌',
  info: 'ℹ️',
};

export const ResultCard: React.FC<ResultCardProps> = ({
  title,
  body,
  verdict = 'info',
  mono,
}) => (
  <View
    style={[
      styles.cardContainer,
      {
        backgroundColor: VERDICT_COLORS[verdict] + '10',
        borderColor: VERDICT_COLORS[verdict] + '40',
      },
    ]}
  >
    <Text style={styles.cardTitle}>
      {VERDICT_ICONS[verdict]} {title}
    </Text>
    {body ? (
      <Text style={[styles.cardBody, mono && styles.cardBodyMono]} selectable>
        {body}
      </Text>
    ) : null}
  </View>
);

// ─── Reference card (NobodyWho result from the report) ──────────

interface ReferenceCardProps {
  title: string;
  body: string;
}

export const ReferenceCard: React.FC<ReferenceCardProps> = ({ title, body }) => (
  <View style={styles.referenceContainer}>
    <Text style={styles.referenceLabel}>
      NobodyWho · reference from comparison.md (not run on this device)
    </Text>
    <Text style={styles.cardTitle}>{title}</Text>
    <Text style={[styles.cardBody, styles.cardBodyMono]} selectable>
      {body}
    </Text>
  </View>
);

// ─── Styles ─────────────────────────────────────────────────────

const styles = StyleSheet.create({
  headerContainer: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    backgroundColor: AppColors.surfaceCard,
    marginBottom: 12,
  },
  headerSection: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
    marginBottom: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: AppColors.textPrimary,
    marginBottom: 6,
  },
  headerClaim: {
    fontSize: 14,
    lineHeight: 19,
    color: AppColors.textSecondary,
  },

  buttonContainer: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    marginBottom: 8,
  },
  buttonDisabledContainer: {
    opacity: 0.5,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '600',
  },

  cardContainer: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: AppColors.textPrimary,
  },
  cardBody: {
    marginTop: 6,
    fontSize: 15,
    lineHeight: 18,
    color: AppColors.textSecondary,
  },
  cardBodyMono: {
    fontFamily: MONO,
  },

  referenceContainer: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: AppColors.accentViolet + '60',
    backgroundColor: AppColors.accentViolet + '0D',
    marginBottom: 8,
  },
  referenceLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: AppColors.accentViolet,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
});
