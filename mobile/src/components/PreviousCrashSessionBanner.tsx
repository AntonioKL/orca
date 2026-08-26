import { AlertTriangle } from 'lucide-react-native'
import { StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export function PreviousCrashSessionBanner() {
  return (
    <View style={styles.banner} testID="previous-crash-session-banner">
      <AlertTriangle size={16} color={colors.statusAmber} />
      <View style={styles.copy}>
        <Text style={styles.title}>Previous session ended abnormally</Text>
        <Text style={styles.description}>
          Crash diagnostics are available to copy and share with support.
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel
  },
  copy: {
    flex: 1,
    gap: spacing.xs
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  description: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 18
  }
})
