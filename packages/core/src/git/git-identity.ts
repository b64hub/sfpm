import { SimpleGit } from 'simple-git';

export default class GitIdentity {
    constructor(private git: SimpleGit) {}

    async setUsernameAndEmail(): Promise<void> {
        await this.setUsername();
        await this.setEmail();
    }

    private async setUsername(): Promise<void> {
        let username: string;

        if (process.env.SFP_GIT_USERNAME) {
            username = process.env.SFP_GIT_USERNAME;
        } else {
            username = 'sfp';
        }

        await this.git.addConfig('user.name', username);
    }

    private async setEmail(): Promise<void> {
        let email: string;

        if (process.env.SFP_GIT_EMAIL) {
            email = process.env.SFP_GIT_EMAIL;
        } else {
            email = 'noreply@example.com';
        }

        await this.git.addConfig('user.email', email);
    }
}
