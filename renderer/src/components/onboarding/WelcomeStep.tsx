import { Button } from '../ui/Button';

interface Props {
  onNext: () => void;
}

export function WelcomeStep({ onNext }: Props) {
  return (
    <div className="flex flex-col items-center gap-8 p-12">
      <h1 className="text-4xl font-bold">欢迎使用 Momo Studio</h1>
      <p className="text-lg text-neutral-400 max-w-md text-center">
        本地优先的多 agent 协作平台。几步完成设置，即可开始使用。
      </p>
      <Button onClick={onNext} size="lg">开始使用</Button>
    </div>
  );
}
