import { Meta } from '@storybook/react';
import React from 'react';
import { RegisterForm } from '../auth/RegisterForm';
import { FooterLinks } from '../FooterLinks';
import { Logo } from '../Logo';

export default {
  title: 'Medplum/RegisterForm',
  component: RegisterForm,
} as Meta;

const recaptchaSiteKey = 'abc';

export function Basic(): JSX.Element {
  return (
    <RegisterForm type="project" recaptchaSiteKey={recaptchaSiteKey} onSuccess={() => alert('Registered!')}>
      <Logo size={32} />
      <h1>Register new account</h1>
    </RegisterForm>
  );
}

export function WithFooter(): JSX.Element {
  return (
    <>
      <RegisterForm type="project" recaptchaSiteKey={recaptchaSiteKey} onSuccess={() => alert('Registered!')}>
        <Logo size={32} />
        <h1>Register new account</h1>
      </RegisterForm>
      <FooterLinks>
        <a href="#">Help</a>
        <a href="#">Terms</a>
        <a href="#">Privacy</a>
      </FooterLinks>
    </>
  );
}

export function WithGoogle(): JSX.Element {
  return (
    <>
      <RegisterForm
        type="project"
        recaptchaSiteKey={recaptchaSiteKey}
        onSuccess={() => alert('Registered!')}
        googleClientId="xyz"
      >
        <Logo size={32} />
        <h1>Register new account</h1>
      </RegisterForm>
      <FooterLinks>
        <a href="#">Help</a>
        <a href="#">Terms</a>
        <a href="#">Privacy</a>
      </FooterLinks>
    </>
  );
}
