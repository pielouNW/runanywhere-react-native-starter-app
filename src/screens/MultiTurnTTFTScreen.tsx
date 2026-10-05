import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { RunAnywhere } from '@runanywhere/core';
import type { ChatMessage, GenerationEvent } from '@runanywhere/core';
import { Chat as NWChat, SamplerPresets } from 'react-native-nobodywho';
import { AppColors } from '../theme';
import { useModelService, MODEL_CREDITS, MODEL_IDS, MODEL_NAMES } from '../services/ModelService';
import { ModelLoaderWidget, ActionButton, FindingHeader, MONO, ResultCard  } from '../components';

const ACCENT = AppColors.accentCyan;
const MAX_TOKENS = 64;

/** RunAnywhere's llama.cpp backend loads with n_ctx 2048 and JS cannot change it, so NobodyWho matches. */
const CONTEXT_SIZE = 2048;

/**
 * Greedy decoding, to match NobodyWho's `SamplerPresets.greedy()`. RunAnywhere
 * builds a bare greedy sampler whenever temperature is 0; the other knobs are
 * pinned anyway so none of its defaults (top-k 40, min-p 0.05, repeat penalty
 * 1.1) can reach the chain.
 */
const RA_GREEDY = {
  temperature: 0,
  topK: 1,
  topP: 1,
  minP: 0,
  repetitionPenalty: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
} as const;

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

const MODEL_ID = MODEL_IDS.attentionLlm;

interface EngineSample {
  ttftMs: number;
  inputTokens: number;
  tokensPerSecond: number;
}

interface NWSample extends EngineSample {
  prefilledTokens: number;
}

interface TurnSample {
  turn: number;
  ra: EngineSample;
  nw: NWSample;
}

/** Stream one RunAnywhere turn and return client-measured TTFT plus the SDK's metrics. */
const runRATurn = async (messages: ChatMessage[]): Promise<{ sample: EngineSample; reply: string }> => {
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
      ...RA_GREEDY,
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

/**
 * Ask one NobodyWho turn. The chat keeps its own history and KV cache, so only
 * the new user message is sent. `contextBefore` is the chat's context use
 * after the previous turn, to tell how much of this prompt was new.
 */
const runNWTurn = async (
  chat: NWChat,
  prompt: string,
  contextBefore: number,
): Promise<{ sample: NWSample; contextAfter: number }> => {
  const startedAt = performance.now();
  let firstTokenAt: number | null = null;
  let generated = 0;

  // Manual iteration, like above: `nextToken` resolves undefined when done.
  const stream = chat.ask(prompt);
  for (;;) {
    const token = await stream.nextToken();
    if (token === undefined) {
      break;
    }
    if (firstTokenAt === null) {
      firstTokenAt = performance.now();
    }
    generated++;
    
    // NobodyWho has no per-ask token cap; stop at the same budget and keep
    // draining so the partial reply lands in the history.
    if (generated === MAX_TOKENS) {
      chat.stopGeneration();
    }
  }
  const finishedAt = performance.now();

  const { contextUsed } = await chat.getStats();
  const inputTokens = Math.max(0, contextUsed - generated);
  const decodeSeconds = firstTokenAt === null ? 0 : (finishedAt - firstTokenAt) / 1000;

  return {
    sample: {
      ttftMs: (firstTokenAt ?? finishedAt) - startedAt,
      inputTokens,
      prefilledTokens: Math.max(0, inputTokens - contextBefore),
      tokensPerSecond: decodeSeconds > 0 ? (generated - 1) / decodeSeconds : 0,
    },
    contextAfter: contextUsed,
  };
};

export const MultiTurnTTFTScreen: React.FC = () => {
  const modelService = useModelService();
  const [samples, setSamples] = useState<TurnSample[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  // Other screens share the engines' single model slots: a run left going
  // after leaving this screen would keep generating while another screen swaps
  // the models underneath it.
  useEffect(() => () => { stopRef.current = true; }, []);

  const handleRun = async () => {
    setIsRunning(true);
    setError(null);
    setSamples([]);
    stopRef.current = false;

    let nwChat: NWChat | null = null;
    const history: ChatMessage[] = [];
    let nwContext = 0;
    try {
      nwChat = new NWChat({
        model: modelService.nwModel!,
        systemPrompt: SYSTEM_PROMPT,
        contextSize: CONTEXT_SIZE,
        sampler: SamplerPresets.greedy(),
        templateVariables: { enable_thinking: false },
      });
      for (let i = 0; i < SCRIPT.length && !stopRef.current; i++) {
        const prompt = SCRIPT[i]!;

        history.push({ role: 'user', content: prompt });
        const { sample: ra, reply } = await runRATurn(history);
        history.push({ role: 'assistant', content: reply });

        const { sample: nw, contextAfter } = await runNWTurn(nwChat, prompt, nwContext);
        nwContext = contextAfter;

        setSamples(prev => [...prev, { turn: i + 1, ra, nw }]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      nwChat?.destroy();
      setIsRunning(false);
    }
  };

  if (modelService.loadedLLMId !== MODEL_ID || modelService.nwModelId !== MODEL_ID) {
    const raBusy = modelService.isLLMDownloading || modelService.isLLMLoading;

    return (
      <ModelLoaderWidget
        modelCredit={MODEL_CREDITS.attentionLlm}
        title="LLM Model Required"
        subtitle="Load the same model in RunAnywhere and NobodyWho to measure multi-turn TTFT"
        icon="chat"
        accentColor={ACCENT}
        isDownloading={raBusy ? modelService.isLLMDownloading : modelService.isNWDownloading}
        isLoading={raBusy ? modelService.isLLMLoading : modelService.isNWLoading}
        progress={raBusy ? modelService.llmDownloadProgress : modelService.nwDownloadProgress}
        progressLabel={raBusy ? 'RunAnywhere' : 'NobodyWho'}
        onLoad={async () => {
          if (modelService.loadedLLMId !== MODEL_ID) {
            await modelService.downloadAndLoadLanguageModel(MODEL_ID);
          }
          await modelService.downloadAndLoadNW(MODEL_ID);
        }}
      />
    );
  }

  const maxTtft = Math.max(1, ...samples.flatMap(s => [s.ra.ttftMs, s.nw.ttftMs]));
  const first = samples[0];
  const last = samples[samples.length - 1];
  const raTotal = samples.reduce((sum, s) => sum + s.ra.ttftMs, 0);
  const nwTotal = samples.reduce((sum, s) => sum + s.nw.ttftMs, 0);

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
            <Text style={styles.legendText}>RunAnywhere</Text>
            <View style={[styles.legendSwatchContainer, { backgroundColor: AppColors.accentViolet }]} />
            <Text style={styles.legendText}>NobodyWho</Text>
          </View>
          {samples.map(s => (
            <View key={s.turn} style={styles.turnRowContainer}>
              <Text style={styles.turnLabel}>{String(s.turn).padStart(2, ' ')}</Text>
              <View style={styles.barsContainer}>
                <View style={[styles.barContainer, { width: `${(s.ra.ttftMs / maxTtft) * 100}%`, backgroundColor: ACCENT }]} />
                <View
                  style={[
                    styles.barContainer,
                    { width: `${(s.nw.ttftMs / maxTtft) * 100}%`, backgroundColor: AppColors.accentViolet },
                  ]}
                />
              </View>
              <View>
                <Text style={[styles.turnValue, { color: ACCENT }]}>{Math.round(s.ra.ttftMs)} ms</Text>
                <Text style={[styles.turnValue, { color: AppColors.accentViolet }]}>{Math.round(s.nw.ttftMs)} ms</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {first && last && samples.length > 1 ? (
        <ResultCard
          title={`RunAnywhere turn ${last.turn} is ${(last.ra.ttftMs / first.ra.ttftMs).toFixed(1)}× slower to start than turn 1`}
          verdict={last.ra.ttftMs > first.ra.ttftMs * 2 ? 'fail' : 'info'}
          mono
          body={
            'RunAnywhere\n' +
            `  turn 1:  ${Math.round(first.ra.ttftMs)} ms  (${first.ra.inputTokens} prompt tokens)\n` +
            `  turn ${last.turn}: ${Math.round(last.ra.ttftMs)} ms  (${last.ra.inputTokens} prompt tokens)\n` +
            `  decode: ${last.ra.tokensPerSecond.toFixed(0)} tok/s\n` +
            'NobodyWho\n' +
            `  turn 1:  ${Math.round(first.nw.ttftMs)} ms  (${first.nw.inputTokens} prompt tokens)\n` +
            `  turn ${last.turn}: ${Math.round(last.nw.ttftMs)} ms  (${last.nw.inputTokens} prompt tokens, ` +
            `~${last.nw.prefilledTokens} new)\n` +
            `  decode: ${last.nw.tokensPerSecond.toFixed(0)} tok/s\n` +
            `cumulative wait: RunAnywhere ${(raTotal / 1000).toFixed(2)} s, NobodyWho ${(nwTotal / 1000).toFixed(2)} s`
          }
        />
      ) : null}

      <ResultCard
        title="Reading the chart"
        body={
          `Both engines run the same ${MODEL_NAMES.attentionLlm} file on this device, one after the ` +
          'other each turn, with greedy sampling and thinking off. The prompt grows with ' +
          'every turn: RunAnywhere prefills all of it again, NobodyWho reuses the cached ' +
          'prefix and prefills only the tail that changed.'
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
