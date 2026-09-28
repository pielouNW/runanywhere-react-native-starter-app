import React, { useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { RunAnywhere } from '@runanywhere/core';
import type { ChatMessage, GenerationEvent } from '@runanywhere/core';
import { AppColors } from '../theme';
import { useModelService, MODEL_CREDITS } from '../services/ModelService';
import { ModelLoaderWidget, ActionButton, FindingHeader, MONO, ResultCard  } from '../components';

const ACCENT = AppColors.accentCyan;
const MAX_TOKENS = 64;

const SYSTEM_PROMPT = 'You are a concise assistant. Answer in two or three sentences.';

const SCRIPT: readonly string[] = [
  'I am planning a week-long trip to Japan in November. Where should I start?',
  'How many days would you spend in Tokyo?',
  'What neighbourhood should I stay in?',
  'Is the JR Pass still worth it?',
  'How do I get from Tokyo to Kyoto?',
  'What are the must-see temples in Kyoto?',
  'Will the autumn leaves be out in November?',
  'Should I book a ryokan?',
  'What is a typical ryokan dinner like?',
  'Is Nara worth a day trip?',
  'How about Osaka for food?',
  'What should I eat in Osaka?',
  'Is it easy to pay by card?',
  'Do I need cash for small shops?',
  'What etiquette mistakes should I avoid?',
  'How do I use the trains without speaking Japanese?',
  'Is Hiroshima reachable in a day from Osaka?',
  'Should I get a pocket Wi-Fi or an eSIM?',
  'What souvenirs are good to bring home?',
  'Can you summarise the itinerary we just discussed?',
];

const NW_REFERENCE_TTFT: readonly number[] = [
  17.2, 20.0, 19.9, 19.8, 20.0, 21.4, 20.4, 21.0, 20.7, 20.6,
  27.0, 27.2, 27.3, 36.3, 23.7, 24.8, 25.7, 30.1, 29.2, 36.6,
];

interface TurnSample {
  turn: number;
  ttftMs: number;
  inputTokens: number;
  tokensPerSecond: number;
}

/** Stream one turn and return client-measured TTFT plus the SDK's metrics. */
const runTurn = async (messages: ChatMessage[]): Promise<{ sample: Omit<TurnSample, 'turn'>; reply: string }> => {
  const startedAt = performance.now();
  let firstTokenAt: number | null = null;
  let reply = '';
  let inputTokens = 0;
  let tokensPerSecond = 0;

  // Manual iteration: Hermes cannot `for await` over NitroModules iterables.
  const iterator: AsyncIterator<GenerationEvent> = RunAnywhere.llm
    .generateStream(messages, {
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: MAX_TOKENS,
      temperature: 0,
      reasoning: { mode: 'off' },
    })
    [Symbol.asyncIterator]();

  for (;;) {
    const step = await iterator.next();
    if (step.done) break;
    const event = step.value;
    if (event.type === 'token') {
      if (firstTokenAt === null) firstTokenAt = performance.now();
      if (event.kind === 'text') reply += event.text;
    } else if (event.type === 'completed') {
      inputTokens = event.result.inputTokens;
      tokensPerSecond = event.result.tokensPerSecond;
      break;
    } else if (event.type === 'failed') {
      throw event.error;
    } else if (event.type === 'cancelled') {
      break;
    }
  }

  return {
    sample: {
      ttftMs: (firstTokenAt ?? performance.now()) - startedAt,
      inputTokens,
      tokensPerSecond,
    },
    reply,
  };
};

export const MultiTurnTTFTScreen: React.FC = () => {
  const modelService = useModelService();
  const [samples, setSamples] = useState<TurnSample[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  const handleRun = async () => {
    setIsRunning(true);
    setError(null);
    setSamples([]);
    stopRef.current = false;

    const history: ChatMessage[] = [];
    try {
      for (let i = 0; i < SCRIPT.length && !stopRef.current; i++) {
        history.push({ role: 'user', content: SCRIPT[i]! });
        const { sample, reply } = await runTurn(history);
        history.push({ role: 'assistant', content: reply });
        setSamples(prev => [...prev, { turn: i + 1, ...sample }]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setIsRunning(false);
    }
  };

  if (!modelService.isLLMLoaded) {
    return (
      <ModelLoaderWidget
        modelCredit={MODEL_CREDITS.llm}
        title="LLM Model Required"
        subtitle="Load a language model to measure multi-turn TTFT"
        icon="chat"
        accentColor={ACCENT}
        isDownloading={modelService.isLLMDownloading}
        isLoading={modelService.isLLMLoading}
        progress={modelService.llmDownloadProgress}
        onLoad={modelService.downloadAndLoadLLM}
      />
    );
  }

  const maxTtft = Math.max(1, ...samples.map(s => s.ttftMs), ...NW_REFERENCE_TTFT);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const raTotal = samples.reduce((sum, s) => sum + s.ttftMs, 0);
  const nwTotal = NW_REFERENCE_TTFT.slice(0, samples.length).reduce((sum, v) => sum + v, 0);

  return (
    <ScrollView style={styles.screenContainer} contentContainerStyle={styles.contentContainer}>
      <FindingHeader
        title="Multi-turn TTFT grows every turn"
        claim={
          'RunAnywhere clears the KV cache before every generation, so each turn ' +
          're-reads the whole conversation. Time-to-first-token should climb in a ' +
          'straight line. NobodyWho reuses the cached prefix and stays flat.'
        }
      />

      <ActionButton
        label={isRunning ? `Running turn ${samples.length + 1}/${SCRIPT.length}` : 'Run 20-turn conversation'}
        onPress={handleRun}
        busy={isRunning && samples.length === 0}
        disabled={isRunning}
        accentColor={ACCENT}
      />
      {isRunning ? (
        <ActionButton label="Stop after this turn" onPress={() => { stopRef.current = true; }} accentColor={AppColors.textMuted} />
      ) : null}

      {error ? <ResultCard title="Generation failed" body={error} verdict="fail" mono /> : null}

      {samples.length > 0 ? (
        <View style={styles.chartContainer}>
          <View style={styles.legendRowContainer}>
            <View style={[styles.legendSwatchContainer, { backgroundColor: ACCENT }]} />
            <Text style={styles.legendText}>RunAnywhere (this device)</Text>
            <View style={[styles.legendSwatchContainer, { backgroundColor: AppColors.accentViolet }]} />
            <Text style={styles.legendText}>NobodyWho (reference)</Text>
          </View>
          {samples.map(s => (
            <View key={s.turn} style={styles.turnRowContainer}>
              <Text style={styles.turnLabel}>{String(s.turn).padStart(2, ' ')}</Text>
              <View style={styles.barsContainer}>
                <View style={[styles.barContainer, { width: `${(s.ttftMs / maxTtft) * 100}%`, backgroundColor: ACCENT }]} />
                <View
                  style={[
                    styles.barContainer,
                    {
                      width: `${(NW_REFERENCE_TTFT[s.turn - 1]! / maxTtft) * 100}%`,
                      backgroundColor: AppColors.accentViolet,
                    },
                  ]}
                />
              </View>
              <Text style={styles.turnValue}>{Math.round(s.ttftMs)} ms</Text>
            </View>
          ))}
        </View>
      ) : null}

      {first && last && samples.length > 1 ? (
        <ResultCard
          title={`Turn ${last.turn} is ${(last.ttftMs / first.ttftMs).toFixed(1)}× slower to start than turn 1`}
          verdict={last.ttftMs > first.ttftMs * 2 ? 'fail' : 'info'}
          mono
          body={
            `turn 1:  ${Math.round(first.ttftMs)} ms  (${first.inputTokens} prompt tokens)\n` +
            `turn ${last.turn}: ${Math.round(last.ttftMs)} ms  (${last.inputTokens} prompt tokens)\n` +
            `cumulative wait: ${(raTotal / 1000).toFixed(2)} s  (NobodyWho ref: ${(nwTotal / 1000).toFixed(2)} s)\n` +
            `decode: ${last.tokensPerSecond.toFixed(0)} tok/s, flat, so the growth is prefill, not decode`
          }
        />
      ) : null}

      <ResultCard
        title="Reading the chart"
        body={
          'The prompt-token count grows with every turn and RunAnywhere prefills all of it ' +
          'again. The NobodyWho bars are Qwen3-0.6B on an M4 Pro (benchmark-summary.json), ' +
          'so compare the shape of the two series, not the absolute values.'
        }
      />
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  screenContainer: {
    flex: 1,
    backgroundColor: AppColors.primaryDark,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  chartContainer: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: AppColors.surfaceCard,
    marginBottom: 8,
  },
  legendRowContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  legendSwatchContainer: {
    width: 10,
    height: 10,
    borderRadius: 2,
  },
  legendText: {
    fontSize: 11,
    color: AppColors.textSecondary,
    marginRight: 8,
  },
  turnRowContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  turnLabel: {
    width: 22,
    fontSize: 11,
    fontFamily: MONO,
    color: AppColors.textMuted,
  },
  barsContainer: {
    flex: 1,
    gap: 2,
  },
  barContainer: {
    height: 5,
    borderRadius: 3,
    minWidth: 2,
  },
  turnValue: {
    width: 64,
    textAlign: 'right',
    fontSize: 11,
    fontFamily: MONO,
    color: AppColors.textPrimary,
  },
});
