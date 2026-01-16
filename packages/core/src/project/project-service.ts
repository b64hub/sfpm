export default class ProjectService {

    constructor() {
    }

    public async getConfig(): Promise<any[]> {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return [{ name: 'Project1' }, { name: 'Project2' }];
    }
}