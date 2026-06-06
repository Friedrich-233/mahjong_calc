import { type FC, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MdCameraAlt, MdClose } from 'react-icons/md';
import { Tile } from '../components/tile';
import { Button } from '../components/ui/Button';
import { useStore } from '../contexts/store';
import { instantiateMeld } from '../lib/input';
import type { Tile as TileType } from '../lib/tile';
import { type AdapterResult, recognitionToInput } from './adapter';
import { recognizeImage } from './api';
import type { RecognitionResult } from './types';

type Status = 'idle' | 'loading' | 'preview' | 'error';

interface Props {
  onClose: () => void;
}

// A horizontal strip of tiles. The Tile component is flex-1, so the strip needs
// an explicit width — mirrors how KeyboardHelp lays tiles out.
const TileRow: FC<{ tiles: TileType[]; winningIndex?: number }> = ({
  tiles,
  winningIndex = -1
}) => (
  <div
    className="flex gap-px"
    style={{ width: `${Math.max(1, tiles.length) * 1.7}rem`, maxWidth: '100%' }}
  >
    {tiles.map((tile, i) => (
      <div
        key={i}
        className={
          i === winningIndex
            ? 'flex-1 rounded-sm ring-2 ring-amber-400'
            : 'flex-1'
        }
      >
        <Tile tile={tile} />
      </div>
    ))}
  </div>
);

export const RecognitionDialog: FC<Props> = ({ onClose }) => {
  const { t } = useTranslation();
  const [
    {
      currentRule: { red }
    },
    dispatch
  ] = useStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [adapter, setAdapter] = useState<AdapterResult | null>(null);
  const [raw, setRaw] = useState<RecognitionResult | null>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setStatus('loading');
    setErrorMsg('');
    try {
      const result = await recognizeImage(file);
      setRaw(result);
      setAdapter(recognitionToInput(result, red));
      setStatus('preview');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  };

  const apply = () => {
    if (adapter === null) return;
    dispatch({ type: 'set-input', payload: adapter.input });
    dispatch({ type: 'set-input-focus', payload: { type: 'hand' } });
    onClose();
  };

  const reset = () => {
    setStatus('idle');
    setAdapter(null);
    setRaw(null);
    setErrorMsg('');
    if (inputRef.current !== null) inputRef.current.value = '';
  };

  const hand = adapter?.input.hand ?? [];
  const winningIndex = hand.length % 3 === 2 ? hand.length - 1 : -1;
  const meldGroups = (adapter?.input.melds ?? []).map(m =>
    instantiateMeld(m, red)
  );

  return (
    <div className="fixed inset-0 z-20 h-full w-full">
      <button
        type="button"
        aria-label="close"
        className="absolute inset-0 h-full w-full cursor-default select-none bg-transparent backdrop-blur-sm [-webkit-tap-highlight-color:transparent]"
        onClick={onClose}
      />
      <div className="mt-16 flex items-start justify-center px-2">
        <div className="flex w-full max-w-md flex-col gap-4 rounded-md border border-neutral-500/50 bg-white/70 p-4 shadow-lg backdrop-blur-md dark:bg-black/60">
          <div className="flex items-center justify-between">
            <div className="text-lg font-bold">{t('recognition.title')}</div>
            <button
              type="button"
              aria-label={t('recognition.close')}
              className="rounded p-1 hover:bg-neutral-500/20"
              onClick={onClose}
            >
              <MdClose />
            </button>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={e => void handleFile(e.target.files?.[0])}
          />

          {status === 'idle' && (
            <>
              <p className="text-sm opacity-80">
                {t('recognition.instructions')}
              </p>
              <Button onClick={() => inputRef.current?.click()}>
                <MdCameraAlt />
                {t('recognition.choose')}
              </Button>
            </>
          )}

          {status === 'loading' && (
            <div className="py-8 text-center text-sm opacity-80">
              {t('recognition.recognizing')}
            </div>
          )}

          {status === 'error' && (
            <>
              <div className="rounded-sm bg-red-500/10 p-2 text-sm text-red-700 dark:text-red-300">
                <div className="font-semibold">{t('recognition.failed')}</div>
                <div className="mt-1 break-words text-xs opacity-80">
                  {errorMsg}
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => inputRef.current?.click()}>
                  {t('recognition.retry')}
                </Button>
                <Button onClick={onClose}>{t('recognition.close')}</Button>
              </div>
            </>
          )}

          {status === 'preview' && adapter !== null && (
            <>
              <div className="text-sm opacity-80">
                {t('recognition.preview')}
              </div>
              <div className="flex flex-col gap-2">
                <TileRow tiles={hand} winningIndex={winningIndex} />
                {meldGroups.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {meldGroups.map((tiles, i) => (
                      <TileRow key={i} tiles={tiles} />
                    ))}
                  </div>
                )}
              </div>

              {raw !== null && (
                <div className="font-mono text-xs opacity-60">
                  {raw.concealed}
                  {raw.melds?.map(m => ` ${m.tiles}`).join('')}
                  {raw.winning_tile ? ` +${raw.winning_tile}` : ''}
                </div>
              )}

              {adapter.warnings.length > 0 && (
                <ul className="text-xs text-amber-700 dark:text-amber-400">
                  {adapter.warnings.map((w, i) => (
                    <li key={i}>• {w}</li>
                  ))}
                </ul>
              )}

              <p className="text-xs opacity-60">
                {t('recognition.review-hint')}
              </p>

              <div className="flex gap-2">
                <Button onClick={apply}>{t('recognition.apply')}</Button>
                <Button onClick={reset}>{t('recognition.again')}</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
