import { redirect } from 'next/navigation';
import { isOssMode } from '@/lib/storage/factory';
import { RegisterFormClient } from './register-form-client';

export default function RegisterPage() {
  if (!isOssMode()) redirect('/login');
  return <RegisterFormClient />;
}
